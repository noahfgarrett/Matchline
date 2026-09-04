using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Autodesk.Navisworks.Api;
using Matchline.Extraction.Ndjson;
using Matchline.Extraction.Protocol;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.NavisworksAdapter
{
    /// <summary>
    /// Walks an open Navisworks document and streams it as NDJSON.
    /// <para>
    /// Ordering is the contract (EXTRACTION.md, design call 5): the document's
    /// references first, then the saved sets, then source models in document
    /// order with items depth-first pre-order and explicit sibling indices,
    /// properties in encounter order per item, and each item's set memberships
    /// immediately after it. The same NWD must produce the same stream every
    /// time.
    /// </para>
    /// <para>
    /// Sets come BEFORE the walk on purpose, and it is a memory decision rather
    /// than a cosmetic one. Resolving them afterwards meant holding a
    /// <c>Dictionary&lt;ModelItem, long&gt;</c> of every item in the model until
    /// the last set was resolved -- one pinned Autodesk object per row, inside
    /// the Navisworks process, for the whole run. Resolving first means the only
    /// items pinned are the ones some set actually names, which on a real model
    /// is a rounding error next to the tree.
    /// </para>
    /// <para>
    /// Failure policy lives in <see cref="WarningCollector"/>, which is shared
    /// with every other year: a per-item or per-property read failure becomes a
    /// warning record and the walk continues. Only a failure that makes the whole
    /// walk meaningless propagates out.
    /// </para>
    /// <para>
    /// Compiled once per supported year from this one file; nothing in it is
    /// version-specific. If a future release needs a different call here, split
    /// only this file per year rather than forking the directory.
    /// </para>
    /// </summary>
    internal sealed class DocumentWalker : IDisposable
    {
        private readonly NdjsonWriter _writer;
        private readonly WarningCollector _warnings;

        /// <summary>
        /// One instance for the whole walk: <c>structural_key</c> is computed
        /// once per object, and creating a hash object per row on a 131k-object
        /// model is a measurable amount of garbage for no benefit.
        /// </summary>
        private readonly SHA256 _hasher = SHA256.Create();

        /// <summary>
        /// Item -> the sets that name it, resolved BEFORE the tree walk.
        /// <para>
        /// This is the only place a <see cref="ModelItem"/> outlives the frame it
        /// was popped from, and entries are removed as the walk reaches them, so
        /// what is pinned shrinks monotonically. Whatever is left when the walk
        /// ends is membership the walk never saw, which is reported.
        /// </para>
        /// VERIFY-ON-WINDOWS (FULLY OPEN -- the stub build cannot help here):
        /// this assumes ModelItem implements value equality (Equals/GetHashCode
        /// over the underlying item), so that the instance handed back by a
        /// selection set matches the one seen during the walk. The stub declares
        /// ModelItem with plain reference equality, so a green stub build says
        /// nothing either way. If membership counts come out at zero, this is why.
        /// </summary>
        private readonly Dictionary<ModelItem, List<long>> _setMembership =
            new Dictionary<ModelItem, List<long>>();

        /// <summary>Set id -> display name, for the "members not found" warning.</summary>
        private readonly Dictionary<long, string> _setNames = new Dictionary<long, string>();

        /// <summary>Reused per item so one buffer serves the whole walk.</summary>
        private readonly List<PropertyRecord> _itemProperties = new List<PropertyRecord>();

        private long _nextObjectId = 1;

        /// <summary>
        /// Shared by top-level models and by nested appended models found during
        /// the walk, so every <c>source_models</c> row has a distinct id.
        /// </summary>
        private long _nextModelId;

        /// <summary>Saved sets resolved so far, and how many there are. Progress only.</summary>
        private long _setsDone;

        private long _setsTotal;

        private bool _disposed;

        internal DocumentWalker(NdjsonWriter writer)
        {
            if (writer == null)
            {
                throw new ArgumentNullException("writer");
            }

            _writer = writer;
            _warnings = new WarningCollector(writer);
        }

        internal long ObjectCount
        {
            get { return _nextObjectId - 1; }
        }

        internal long WarningCount
        {
            get { return _warnings.Count; }
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _hasher.Dispose();
        }

        internal void Walk(Document document)
        {
            if (document == null)
            {
                throw new ArgumentNullException("document");
            }

            WriteSourceReferences(document);
            ResolveSelectionSets(document);
            WalkSourceModels(document);
            ReportMembersTheWalkNeverSaw();
        }

        // ------------------------------------------------------- references

        /// <summary>
        /// One <c>ref</c> record per <c>Document.Models</c> entry, before
        /// anything else.
        /// <para>
        /// It exists for NWF inputs. An NWF holds references rather than
        /// geometry, so a reference whose file has moved produces a document
        /// that opens cleanly, walks cleanly, terminates cleanly and describes a
        /// site with a discipline missing. The launcher cannot open the NWF to
        /// check -- that would need Navisworks, which is what it is starting --
        /// so the plugin says what it found and the launcher refuses to commit a
        /// cache built from an incomplete document.
        /// </para>
        /// </summary>
        private void WriteSourceReferences(Document document)
        {
            // The enumeration itself is inside the try, and nothing is assigned
            // to an interface first: the exact type of Document.Models is one of
            // the things the stub cannot pin, and foreach only needs a pattern.
            try
            {
                foreach (Model model in document.Models)
                {
                    SourceReferenceRecord record = new SourceReferenceRecord();
                    string sourcePath = ReadSourceFilePath(model);

                    // Only the name is ever recorded; the full path exists in
                    // this method and nowhere else, because it is a local path
                    // and a cache is portable (EXTRACTION.md, confidentiality).
                    record.SourceFileName = FileNameOnly(sourcePath);
                    if (string.IsNullOrEmpty(record.SourceFileName))
                    {
                        record.SourceFileName = FileNameOnly(ReadModelFilePath(model));
                    }

                    record.Loaded = IsReferenceLoaded(model, sourcePath);
                    _writer.WriteSourceReference(record);

                    if (!record.Loaded)
                    {
                        _warnings.Warn(
                            WarningSeverity.Error,
                            WarningCodes.SourceModelMissing,
                            "The document references '" +
                            (record.SourceFileName ?? "an unnamed file") +
                            "' but that file is not where the document expects it and nothing " +
                            "was loaded from it. Everything it holds is absent from this " +
                            "extraction.",
                            null);
                    }
                }
            }
            catch (Exception ex)
            {
                _warnings.WarnException(
                    WarningSeverity.Warning, WarningCodes.SourceModelReadFailed, ex, null);
            }
        }

        /// <summary>
        /// Whether a referenced model actually came in.
        /// <para>
        /// Both halves are required before an absence is claimed, because either
        /// one alone is ordinary: an appended file may legitimately be empty,
        /// and a file loaded from a path that has since moved is still loaded.
        /// A check that cannot be made answers "loaded" -- this decides whether
        /// a whole extraction is thrown away, so it must never guess in the
        /// direction of failure.
        /// </para>
        /// </summary>
        private static bool IsReferenceLoaded(Model model, string sourcePath)
        {
            try
            {
                ModelItem root = model.RootItem;
                if (root != null)
                {
                    foreach (ModelItem child in root.Children)
                    {
                        // One child is enough; the enumeration is lazy and this
                        // must not walk the model a second time.
                        if (child != null)
                        {
                            return true;
                        }
                    }
                }
            }
            catch (Exception)
            {
                return true;
            }

            if (string.IsNullOrEmpty(sourcePath))
            {
                return true;
            }

            try
            {
                return File.Exists(sourcePath);
            }
            catch (Exception)
            {
                return true;
            }
        }

        // ------------------------------------------------------- saved sets

        /// <summary>
        /// Resolves every saved set into <see cref="_setMembership"/> and writes
        /// its row, before a single object record exists.
        /// <para>
        /// The <c>set</c> rows going first is what lets the <c>member</c> rows be
        /// written inline during the walk: both ends of a member row exist by the
        /// time it is written, so the stream still replays into a cache with
        /// foreign keys on.
        /// </para>
        /// </summary>
        private void ResolveSelectionSets(Document document)
        {
            SavedItem root;
            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                // Document.SelectionSets has a RootItem assignable to SavedItem).
                // NOT pinned: that it is specifically a FolderItem, nor that it
                // holds the whole saved-set tree.
                root = document.SelectionSets.RootItem;
            }
            catch (Exception ex)
            {
                _warnings.WarnException(WarningSeverity.Warning, WarningCodes.SelectionSetReadFailed, ex, null);
                return;
            }

            if (root == null)
            {
                return;
            }

            // Counted before the first one is resolved, so the stage can report a
            // real total. The saved-set tree is a handful of nodes even on a huge
            // model -- this pass costs nothing next to running one search.
            _setsTotal = CountSelectionSets(root);
            _setsDone = 0;

            // Announced even when there are none: a stage that only appears when
            // it has work to report is a stage a reader cannot tell from a stage
            // that stalled before its first line.
            ReportSetProgress();

            long nextSetId = 1;
            WalkSavedItemChildren(document, root, null, ref nextSetId);
        }

        /// <summary>
        /// Saved sets (not folders) anywhere beneath <paramref name="parent"/>.
        /// <para>
        /// Best effort by design: this number is a progress denominator and
        /// nothing else, so a subtree that will not enumerate here is counted as
        /// zero rather than failing the walk. The real traversal that follows
        /// reports its own failure properly.
        /// </para>
        /// </summary>
        private static long CountSelectionSets(SavedItem parent)
        {
            GroupItem group = parent as GroupItem;
            if (group == null)
            {
                return 0;
            }

            long count = 0;
            try
            {
                foreach (SavedItem child in group.Children)
                {
                    if (child is SelectionSet)
                    {
                        count++;
                    }
                    else
                    {
                        count += CountSelectionSets(child);
                    }
                }
            }
            catch (Exception)
            {
                // See the summary: a denominator is not worth a failed extraction.
            }

            return count;
        }

        private void ReportSetProgress()
        {
            _writer.WriteProgress(ExtractionStages.Sets, _setsDone, _setsTotal);
        }

        private void WalkSavedItemChildren(
            Document document, SavedItem parent, long? parentSetId, ref long nextSetId)
        {
            // VERIFY-ON-WINDOWS (shape pinned by the stub build: GroupItem.Children
            // is enumerable with element type SavedItem, and FolderItem derives from
            // GroupItem). NOT pinned, and load-bearing: that SelectionSet does NOT
            // derive from GroupItem. If it does, this cast succeeds and the walk
            // recurses into a selection set. That compiles either way.
            GroupItem group = parent as GroupItem;
            if (group == null)
            {
                return;
            }

            // Materialised first: the recursive call below writes records while
            // this collection would otherwise still be being enumerated.
            List<SavedItem> children = new List<SavedItem>();
            try
            {
                foreach (SavedItem child in group.Children)
                {
                    children.Add(child);
                }
            }
            catch (Exception ex)
            {
                _warnings.WarnException(WarningSeverity.Warning, WarningCodes.SelectionSetReadFailed, ex, null);
                return;
            }

            foreach (SavedItem child in children)
            {
                long setId = nextSetId++;

                try
                {
                    SelectionSet selectionSet = child as SelectionSet;
                    SelectionSetRecord record = new SelectionSetRecord();
                    record.Id = setId;
                    record.ParentId = parentSetId;
                    record.Name = SafeString(child.DisplayName) ?? string.Empty;
                    record.Guid = ReadSavedItemGuid(child);

                    if (selectionSet == null)
                    {
                        record.Kind = SelectionSetKind.Folder;

                        // A folder holds no members of its own, so there is
                        // nothing to resolve and nothing to be honest about.
                        record.MembershipResolved = true;
                        _writer.WriteSelectionSet(record);
                        WalkSavedItemChildren(document, child, setId, ref nextSetId);
                        continue;
                    }

                    // VERIFY-ON-WINDOWS (shape pinned by the stub build: a bool
                    // property on SelectionSet). NOT pinned: that it means "fixed
                    // selection rather than saved search".
                    bool isExplicit = selectionSet.HasExplicitModelItems;
                    record.Kind = isExplicit ? SelectionSetKind.Selection : SelectionSetKind.Search;

                    // Membership is worked out BEFORE the set row is written,
                    // because the row has to state whether it is resolved and a
                    // cache reader must never see a row that says "resolved" and
                    // then find no members because the search failed after it.
                    List<ModelItem> members;
                    string failure;
                    bool resolved = isExplicit
                        ? TryReadExplicitMembers(selectionSet, out members, out failure)
                        : TryResolveSearchMembers(document, selectionSet, out members, out failure);

                    record.MembershipResolved = resolved;
                    _writer.WriteSelectionSet(record);

                    if (resolved)
                    {
                        _setNames[setId] = record.Name;
                        RememberMembers(members, setId);
                    }
                    else
                    {
                        // No member rows at all, deliberately: absent membership
                        // is not empty membership. A reader that cannot tell the
                        // two apart would answer "this set holds nothing" to a
                        // question nobody managed to ask
                        // (docs/RELEASE-1.0-PLAN.md P0-3).
                        _warnings.Warn(
                            WarningSeverity.Warning,
                            isExplicit
                                ? WarningCodes.SelectionSetReadFailed
                                : WarningCodes.SearchSetUnresolved,
                            (isExplicit ? "Selection set '" : "Search set '") + record.Name +
                            "' could not be resolved and is recorded without members: " + failure,
                            null);
                    }

                    _setsDone++;
                    ReportSetProgress();
                }
                catch (Exception ex)
                {
                    _warnings.WarnException(WarningSeverity.Warning, WarningCodes.SelectionSetReadFailed, ex, null);
                }
            }
        }

        /// <summary>
        /// The set's own persistent identity.
        /// <para>
        /// VERIFY-ON-WINDOWS (shape pinned by this code and by the stub:
        /// SavedItem.Guid is a System.Guid, because it is compared to Guid.Empty
        /// and formatted with "D"). NOT pinned: that it is stable across saves,
        /// which is the whole reason it is recorded -- a set that is renamed must
        /// still be the same set.
        /// </para>
        /// </summary>
        private static string ReadSavedItemGuid(SavedItem item)
        {
            try
            {
                Guid guid = item.Guid;
                return guid == Guid.Empty ? null : guid.ToString("D", CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// The items a fixed selection lists, or false with the reason.
        /// </summary>
        private static bool TryReadExplicitMembers(
            SelectionSet selectionSet, out List<ModelItem> members, out string failure)
        {
            members = new List<ModelItem>();
            failure = null;

            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                // SelectionSet.ExplicitModelItems is enumerable with element type
                // ModelItem).
                foreach (ModelItem member in selectionSet.ExplicitModelItems)
                {
                    members.Add(member);
                }

                return true;
            }
            catch (Exception ex)
            {
                failure = FailureClassifier.Describe(ex);
                return false;
            }
        }

        /// <summary>
        /// Resolves a Search Set's real membership, or returns false with the
        /// reason it could not.
        /// <para>
        /// Two ways, in order. <c>GetSelectedItems()</c> is what the Navisworks
        /// UI itself shows for a set and is asked first because it is the set's
        /// own answer rather than a re-derivation of it. Re-running the search is
        /// the fallback, and it is the expensive one -- the search runs over the
        /// whole document -- which is why the caller reports progress per set.
        /// </para>
        /// <para>
        /// An empty answer from the first way falls through to the second rather
        /// than being believed. "The set selects nothing" and "the set was never
        /// evaluated in this headless session" look identical from here, and
        /// recording the second as the first is exactly the empty-as-answer
        /// failure P0-3 forbids.
        /// </para>
        /// <para>
        /// VERIFY-ON-WINDOWS (shape pinned by the stub build:
        /// SelectionSet.GetSelectedItems() returns a ModelItemCollection,
        /// SelectionSet.HasSearch is a bool, SelectionSet.Search returns a
        /// Search, and Search.FindAll(Document, bool) returns something
        /// enumerable of ModelItem). FULLY OPEN, all of it semantic:
        /// </para>
        /// <para>
        /// (1) that <c>GetSelectedItems</c> evaluates the set rather than
        /// returning whatever was last selected in a UI that is not running;
        /// </para>
        /// <para>
        /// (2) that FindAll's bool argument is <c>includeHidden</c>. It is passed
        /// <c>true</c> to match the tree walk, which visits hidden items -- a
        /// set resolved without them would name fewer objects than the cache
        /// holds, and the difference would show up as unresolved members rather
        /// than as an error. If the argument means something else, this is the
        /// first line to revisit;
        /// </para>
        /// <para>
        /// (3) that a search can be run at all inside a -NoGUI session. If it
        /// cannot, every search set comes back unresolved with the exception text
        /// in its warning, which is exactly the honest fallback the plan asks
        /// for;
        /// </para>
        /// <para>
        /// (4) that the ModelItems either way compare equal to the ones seen
        /// during the tree walk. That is the same open question
        /// <see cref="_setMembership"/> rests on, and here it fails differently:
        /// the set resolves, and every member lands in the unresolved-member
        /// count instead.
        /// </para>
        /// </summary>
        private static bool TryResolveSearchMembers(
            Document document, SelectionSet selectionSet, out List<ModelItem> members, out string failure)
        {
            members = new List<ModelItem>();
            failure = null;

            try
            {
                ModelItemCollection selected = selectionSet.GetSelectedItems();
                if (selected != null)
                {
                    foreach (ModelItem item in selected)
                    {
                        members.Add(item);
                    }
                }

                if (members.Count > 0)
                {
                    return true;
                }
            }
            catch (Exception)
            {
                // Fall through to the search: this is the cheap way, not the
                // authoritative one, and its failure is not the set's verdict.
                members.Clear();
            }

            try
            {
                if (!selectionSet.HasSearch)
                {
                    // Neither an explicit list nor a search: there is no question
                    // this adapter knows how to ask, so it says so rather than
                    // recording an empty set.
                    failure = "the set carries neither explicit items nor a search.";
                    return false;
                }

                Search search = selectionSet.Search;
                if (search == null)
                {
                    failure = "the set reports a search but does not provide one.";
                    return false;
                }

                ModelItemCollection found = search.FindAll(document, true);
                if (found == null)
                {
                    failure = "the search returned nothing at all, not even an empty result.";
                    return false;
                }

                members.Clear();
                foreach (ModelItem item in found)
                {
                    members.Add(item);
                }

                // A search that legitimately matches nothing is resolved with
                // zero members, and the cache records exactly that: kind
                // 'search', membership_resolved 1, no member rows. That is a
                // different fact from this method returning false.
                return true;
            }
            catch (Exception ex)
            {
                failure = FailureClassifier.Describe(ex);
                return false;
            }
        }

        /// <summary>
        /// Files one set's membership against the items themselves, so the walk
        /// can answer "is this item in a set" without keeping the tree.
        /// <para>
        /// A set that lists the same item twice records it twice; the cache's
        /// INSERT OR IGNORE collapses the rows, and counting it twice here is
        /// what keeps the "members the walk never saw" arithmetic honest.
        /// </para>
        /// </summary>
        private void RememberMembers(List<ModelItem> members, long setId)
        {
            for (int i = 0; i < members.Count; i++)
            {
                ModelItem member = members[i];
                if (member == null)
                {
                    continue;
                }

                List<long> sets;
                if (!_setMembership.TryGetValue(member, out sets))
                {
                    sets = new List<long>(1);
                    _setMembership[member] = sets;
                }

                sets.Add(setId);
            }
        }

        /// <summary>
        /// Writes the member rows for one walked object and lets go of the item.
        /// </summary>
        private void EmitMembership(ModelItem item, long objectId)
        {
            if (_setMembership.Count == 0)
            {
                return;
            }

            List<long> sets;
            if (!_setMembership.TryGetValue(item, out sets))
            {
                return;
            }

            _setMembership.Remove(item);

            for (int i = 0; i < sets.Count; i++)
            {
                SelectionSetMemberRecord record = new SelectionSetMemberRecord();
                record.SetId = sets[i];
                record.ObjectId = objectId;
                _writer.WriteSelectionSetMember(record);
            }
        }

        /// <summary>
        /// Whatever membership the walk never reached, reported once per set.
        /// <para>
        /// These are a membership question this cache cannot answer per item,
        /// not a set that failed to resolve: the set is still recorded as
        /// resolved, with the members that were found.
        /// </para>
        /// </summary>
        private void ReportMembersTheWalkNeverSaw()
        {
            if (_setMembership.Count == 0)
            {
                return;
            }

            Dictionary<long, long> bySet = new Dictionary<long, long>();
            foreach (KeyValuePair<ModelItem, List<long>> pair in _setMembership)
            {
                List<long> sets = pair.Value;
                for (int i = 0; i < sets.Count; i++)
                {
                    long existing;
                    bySet.TryGetValue(sets[i], out existing);
                    bySet[sets[i]] = existing + 1;
                }
            }

            _setMembership.Clear();

            // Ascending set id, so two runs over the same model produce the same
            // warnings in the same order.
            List<long> setIds = new List<long>(bySet.Keys);
            setIds.Sort();

            for (int i = 0; i < setIds.Count; i++)
            {
                long setId = setIds[i];
                string name;
                if (!_setNames.TryGetValue(setId, out name))
                {
                    name = string.Empty;
                }

                _warnings.Warn(
                    WarningSeverity.Warning,
                    WarningCodes.SelectionSetMemberUnresolved,
                    bySet[setId].ToString(CultureInfo.InvariantCulture) +
                    " member(s) of set '" + name + "' (id " +
                    setId.ToString(CultureInfo.InvariantCulture) +
                    ") did not match any walked item.",
                    null);
            }
        }

        // ------------------------------------------------------ source models

        private void WalkSourceModels(Document document)
        {
            int rootPathIndex = 0;

            // VERIFY-ON-WINDOWS (shape pinned by the stub build): Document.Models
            // is enumerable with element type Model, and exposes .Count (used in
            // MatchlineExtractAddIn). Still unconfirmed against the real assembly.
            foreach (Model model in document.Models)
            {
                long modelId = ++_nextModelId;

                try
                {
                    _writer.WriteSourceModel(BuildSourceModelRecord(model, modelId, null, null));
                }
                catch (Exception ex)
                {
                    _warnings.WarnException(
                        WarningSeverity.Warning, WarningCodes.SourceModelReadFailed, ex, null);
                    SourceModelRecord fallback = new SourceModelRecord();
                    fallback.Id = modelId;
                    _writer.WriteSourceModel(fallback);
                }

                ModelItem root = null;
                try
                {
                    // VERIFY-ON-WINDOWS (shape pinned by the stub build):
                    // Model.RootItem is a property of type ModelItem.
                    root = model.RootItem;
                }
                catch (Exception ex)
                {
                    _warnings.WarnException(WarningSeverity.Error, WarningCodes.SourceModelReadFailed, ex, null);
                }

                if (root != null)
                {
                    WalkItems(root, modelId, rootPathIndex);
                }

                rootPathIndex++;
            }
        }

        /// <summary>
        /// One <c>source_models</c> row.
        /// </summary>
        /// <param name="parentModelId">
        /// The model this one is appended inside, or null for a top-level model.
        /// </param>
        /// <param name="displayNameOverride">
        /// For a nested model, the tree item that carries it -- the item's own
        /// name is what a person sees in Navisworks. Null reads the model's root.
        /// </param>
        private SourceModelRecord BuildSourceModelRecord(
            Model model, long modelId, long? parentModelId, string displayNameOverride)
        {
            SourceModelRecord record = new SourceModelRecord();
            record.Id = modelId;
            record.ParentId = parentModelId;

            // VERIFY-ON-WINDOWS (shape pinned by the stub build: Model.FileName is
            // a string property). What is NOT pinned is the meaning: that it holds
            // the appended file's path.
            // Only the file name is recorded -- directories would leak local
            // paths into a portable cache (EXTRACTION.md, confidentiality).
            record.FileName = FileNameOnly(ReadModelFilePath(model));

            // VERIFY-ON-WINDOWS (shape pinned by the stub build: Model.SourceFileName
            // is a string property). It is recorded ALONGSIDE FileName rather
            // than instead of it: on a converted model the two differ -- one names
            // the .nwc Navisworks read, the other the .rvt or .dwg it came from --
            // and which one a site recognises is not this code's call to make.
            record.SourceFileName = FileNameOnly(ReadSourceFilePath(model));

            if (displayNameOverride != null)
            {
                record.DisplayName = SafeString(displayNameOverride);
            }
            else
            {
                try
                {
                    ModelItem root = model.RootItem;
                    record.DisplayName = root == null ? null : SafeString(root.DisplayName);
                }
                catch (Exception)
                {
                    record.DisplayName = null;
                }
            }

            record.Guid = ReadModelGuid(model);
            record.SourceGuid = ReadModelSourceGuid(model);
            return record;
        }

        /// <summary>
        /// Source model GUID, read reflectively.
        /// <para>
        /// Deliberate: the member name for this varies by release (SourceGuid /
        /// Guid / ModelGuid) and it is descriptive metadata, not control flow.
        /// Reflection keeps a wrong guess from being a compile error on a project
        /// that cannot be compiled here, and keeps this file identical across
        /// years. It is kept even though schema v3 also records
        /// <c>source_guid</c> from a direct <c>Model.SourceGuid</c> read: if the
        /// direct member turns out not to exist on some year, this is the column
        /// that still answers, and if both answer they can be compared.
        /// VERIFY-ON-WINDOWS (FULLY OPEN): the stub build cannot check a
        /// reflective lookup.
        /// </para>
        /// </summary>
        private static string ReadModelGuid(Model model)
        {
            return ReflectionProbe.ReadString(
                typeof(Model),
                model,
                new string[] { "SourceGuid", "Guid", "ModelGuid" },
                Guid.Empty.ToString());
        }

        /// <summary>
        /// <c>Model.SourceGuid</c>, read directly.
        /// <para>
        /// VERIFY-ON-WINDOWS (pinned by this code: it must be a System.Guid,
        /// because it is compared to Guid.Empty and formatted with "D").
        /// </para>
        /// </summary>
        private static string ReadModelSourceGuid(Model model)
        {
            try
            {
                Guid guid = model.SourceGuid;
                return guid == Guid.Empty ? null : guid.ToString("D", CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string ReadModelFilePath(Model model)
        {
            try
            {
                return SafeString(model.FileName);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string ReadSourceFilePath(Model model)
        {
            try
            {
                return SafeString(model.SourceFileName);
            }
            catch (Exception)
            {
                return null;
            }
        }

        // -------------------------------------------------------------- items

        /// <summary>
        /// Depth-first pre-order walk using an explicit stack rather than
        /// recursion, so a pathologically deep model cannot overflow the stack
        /// inside the Autodesk process.
        /// </summary>
        private void WalkItems(ModelItem root, long sourceModelId, int rootPathIndex)
        {
            Stack<Frame> pending = new Stack<Frame>();
            pending.Push(new Frame(root, null, rootPathIndex, 0, sourceModelId, null));

            List<ModelItem> children = new List<ModelItem>();

            while (pending.Count > 0)
            {
                Frame frame = pending.Pop();
                long objectId = _nextObjectId++;
                long flags = ReadFlags(frame.Item, objectId);
                long itemModelId = frame.SourceModelId;

                // An item that carries a model of its own, below the root of the
                // walk, is an appended file: everything under it belongs to that
                // file rather than to the one it was appended into. Depth is what
                // excludes the model's own root, which also reports HasModel and
                // has already been written by WalkSourceModels.
                if (frame.Depth > 0 && (flags & ObjectFlags.HasModel) != 0)
                {
                    long nested = EmitNestedSourceModel(frame.Item, frame.SourceModelId);
                    if (nested != 0)
                    {
                        itemModelId = nested;
                    }
                }

                string structuralKey = EmitObject(frame, objectId, itemModelId, flags);
                EmitMembership(frame.Item, objectId);

                children.Clear();
                try
                {
                    // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                    // ModelItem.Children is enumerable with element type ModelItem).
                    // NOT pinned: that the order it yields is document order, which
                    // is what makes path_index meaningful.
                    foreach (ModelItem child in frame.Item.Children)
                    {
                        children.Add(child);
                    }
                }
                catch (Exception ex)
                {
                    _warnings.WarnException(WarningSeverity.Warning, WarningCodes.ItemReadFailed, ex, objectId);
                    continue;
                }

                // Reverse push so siblings pop in document order.
                for (int i = children.Count - 1; i >= 0; i--)
                {
                    pending.Push(new Frame(children[i], objectId, i, frame.Depth + 1, itemModelId, structuralKey));
                }
            }
        }

        /// <summary>
        /// Writes the <c>source_models</c> row for an appended model found during
        /// the walk, and answers its id (0 when it could not be read).
        /// </summary>
        private long EmitNestedSourceModel(ModelItem item, long parentModelId)
        {
            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                // ModelItem.HasModel is a bool and ModelItem.Model is a Model).
                // NOT pinned, and load-bearing: that Model here is the appended
                // file rather than the document's own top-level model. If it is
                // the latter, every appended item would open a new source model
                // row per item -- which would show up immediately as a
                // source_models table the size of the tree.
                Model model = item.Model;
                if (model == null)
                {
                    return 0;
                }

                long modelId = ++_nextModelId;
                _writer.WriteSourceModel(
                    BuildSourceModelRecord(model, modelId, parentModelId, SafeString(item.DisplayName)));
                return modelId;
            }
            catch (Exception ex)
            {
                _warnings.WarnException(
                    WarningSeverity.Warning, WarningCodes.SourceModelReadFailed, ex, null);
                return 0;
            }
        }

        /// <summary>
        /// The structure and visibility bits of one item.
        /// <para>
        /// VERIFY-ON-WINDOWS (shape pinned by the stub build: all six are bool
        /// properties on ModelItem). NOT pinned: what each one means, and in
        /// particular whether IsHidden reflects only this item or also an
        /// ancestor that was hidden. The bitfield records what the API says and
        /// draws no conclusion from it.
        /// </para>
        /// <para>
        /// One try/catch for all six rather than six: they are one read of one
        /// item's own state, and a model that will not answer one of them will
        /// not answer the others either.
        /// </para>
        /// </summary>
        private long ReadFlags(ModelItem item, long objectId)
        {
            try
            {
                long flags = ObjectFlags.None;
                if (item.IsHidden)
                {
                    flags |= ObjectFlags.Hidden;
                }

                if (item.IsLayer)
                {
                    flags |= ObjectFlags.Layer;
                }

                if (item.IsInsert)
                {
                    flags |= ObjectFlags.Insert;
                }

                if (item.IsComposite)
                {
                    flags |= ObjectFlags.Composite;
                }

                if (item.IsCollection)
                {
                    flags |= ObjectFlags.Collection;
                }

                if (item.HasModel)
                {
                    flags |= ObjectFlags.HasModel;
                }

                return flags;
            }
            catch (Exception ex)
            {
                _warnings.DeferException(WarningSeverity.Info, WarningCodes.ItemReadFailed, ex, objectId);
                return ObjectFlags.None;
            }
        }

        /// <summary>
        /// Writes one object record and its properties, then any warnings raised
        /// while building them, and answers the object's structural key.
        /// <para>
        /// The order is deliberate, and the reason is in
        /// <see cref="WarningCollector"/>: a warning carrying this item's object
        /// id must not reach the stream before the row it names exists. That is
        /// also why the properties are collected into a buffer before the object
        /// row is written rather than streamed as they are read -- the authoring
        /// id is one of them, and it belongs in the row.
        /// </para>
        /// </summary>
        private string EmitObject(Frame frame, long objectId, long sourceModelId, long flags)
        {
            ObjectRecord record = new ObjectRecord();
            record.Id = objectId;
            record.SourceModelId = sourceModelId;
            record.ParentId = frame.ParentId;
            record.PathIndex = frame.PathIndex;
            record.Depth = frame.Depth;
            record.Flags = flags;

            string displayName = null;
            string className = null;

            try
            {
                displayName = SafeString(frame.Item.DisplayName);

                // VERIFY-ON-WINDOWS (shape pinned by the stub build: both are
                // string properties on ModelItem). NOT pinned: which of the two is
                // the display form. The schema wants the display form.
                className = SafeString(frame.Item.ClassDisplayName);
                if (string.IsNullOrEmpty(className))
                {
                    className = SafeString(frame.Item.ClassName);
                }

                // VERIFY-ON-WINDOWS (pinned by the stub build, and hard-pinned by
                // this code: ModelItem.InstanceGuid must be a System.Guid, not a
                // string -- it is compared to Guid.Empty and formatted with "D").
                Guid instanceGuid = frame.Item.InstanceGuid;
                record.InstanceGuid = instanceGuid == Guid.Empty
                    ? null
                    : instanceGuid.ToString("D", CultureInfo.InvariantCulture);
            }
            catch (Exception ex)
            {
                _warnings.DeferException(WarningSeverity.Warning, WarningCodes.ItemReadFailed, ex, objectId);
            }

            record.DisplayName = displayName;
            record.ClassName = className;

            string structuralKey = StructuralKey(frame.ParentStructuralKey, className, displayName, frame.PathIndex);
            record.StructuralKey = structuralKey;

            CollectProperties(frame.Item, objectId);
            string authoringIdKind;
            record.AuthoringId = FindAuthoringId(out authoringIdKind);
            record.AuthoringIdKind = authoringIdKind;

            record.BoundingBox = ReadBoundingBox(frame.Item, objectId);

            _writer.WriteObject(record);
            _warnings.FlushDeferred();

            for (int i = 0; i < _itemProperties.Count; i++)
            {
                _writer.WriteProperty(_itemProperties[i]);
            }

            _itemProperties.Clear();
            return structuralKey;
        }

        /// <summary>
        /// The object's place in the tree, as a digest of the chain that leads to
        /// it.
        /// <para>
        /// Shape and naming only -- class, display name, sibling position -- and
        /// never a property value, so a model re-exported with every property
        /// rewritten still produces the same keys. Chaining the parent's digest
        /// rather than re-hashing the whole ancestor list is what makes it O(1)
        /// per object AND gives the property that matters: inserting a sibling
        /// changes that sibling's position and every position after it, and
        /// nothing before it.
        /// </para>
        /// <para>
        /// The separators are control characters that cannot occur in a
        /// Navisworks display name, so no two different chains can spell the same
        /// input.
        /// </para>
        /// </summary>
        private string StructuralKey(string parentKey, string className, string displayName, int pathIndex)
        {
            string material =
                (parentKey ?? string.Empty) + "\u001e" +
                (className ?? string.Empty) + "\u001f" +
                (displayName ?? string.Empty) + "\u001f" +
                pathIndex.ToString(CultureInfo.InvariantCulture);

            byte[] digest = _hasher.ComputeHash(Encoding.UTF8.GetBytes(material));
            StringBuilder hex = new StringBuilder(digest.Length * 2);
            for (int i = 0; i < digest.Length; i++)
            {
                hex.Append(digest[i].ToString("x2", CultureInfo.InvariantCulture));
            }

            return hex.ToString();
        }

        private double[] ReadBoundingBox(ModelItem item, long objectId)
        {
            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build: BoundingBox()
                // is a METHOD, not a property, returning a nullable reference type
                // with a bool IsEmpty and Min/Max of Point3D with double X/Y/Z).
                //
                // Called unconditionally. It used to be gated on HasGeometry,
                // which was wrong twice over: a composite item has bounds without
                // having geometry of its own, so the gate dropped exactly the
                // boxes a reader wants, and "HasGeometry is cheap" was never
                // verified either. IsEmpty is the API's own answer to "is there a
                // box", and it is the one that is actually about the box.
                BoundingBox3D box = item.BoundingBox();
                if (box == null || box.IsEmpty)
                {
                    return null;
                }

                Point3D min = box.Min;
                Point3D max = box.Max;
                return new double[] { min.X, min.Y, min.Z, max.X, max.Y, max.Z };
            }
            catch (Exception ex)
            {
                _warnings.DeferException(WarningSeverity.Info, WarningCodes.BoundingBoxReadFailed, ex, objectId);
                return null;
            }
        }

        // --------------------------------------------------------- properties

        /// <summary>
        /// Reads one item's properties into <see cref="_itemProperties"/>.
        /// Warnings are deferred, because the object row they name is written
        /// after this returns.
        /// </summary>
        private void CollectProperties(ModelItem item, long objectId)
        {
            _itemProperties.Clear();

            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                // ModelItem.PropertyCategories is enumerable with element type
                // PropertyCategory). Iterated with foreach rather than assigned to
                // an interface, so the exact collection type does not have to be
                // guessed -- which is also why the stub's name for it is arbitrary.
                foreach (PropertyCategory category in item.PropertyCategories)
                {
                    CollectCategory(category, objectId);
                }
            }
            catch (Exception ex)
            {
                _warnings.DeferException(WarningSeverity.Warning, WarningCodes.CategoryReadFailed, ex, objectId);
            }
        }

        private void CollectCategory(PropertyCategory category, long objectId)
        {
            string categoryDisplay;
            string categoryInternal;

            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build: both are
                // string properties). NOT pinned: which one is the display form.
                categoryDisplay = SafeString(category.DisplayName);
                categoryInternal = SafeString(category.Name);
            }
            catch (Exception ex)
            {
                _warnings.DeferException(WarningSeverity.Warning, WarningCodes.CategoryReadFailed, ex, objectId);
                return;
            }

            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                // PropertyCategory.Properties is enumerable with element type
                // DataProperty).
                foreach (DataProperty property in category.Properties)
                {
                    try
                    {
                        PropertyRecord record = new PropertyRecord();
                        record.ObjectId = objectId;
                        record.Category = categoryDisplay ?? string.Empty;
                        record.CategoryInternal = categoryInternal;

                        // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                        // DisplayName and Name are strings, Value is a reference
                        // type so a null value is representable).
                        record.Name = SafeString(property.DisplayName) ?? string.Empty;
                        record.NameInternal = SafeString(property.Name);

                        string valueType;
                        string valueText;
                        VariantFormatter.Format(property.Value, out valueType, out valueText);
                        record.ValueType = valueType;
                        record.ValueText = valueText;

                        _itemProperties.Add(record);
                    }
                    catch (Exception ex)
                    {
                        // Per EXTRACTION.md: a property that will not read is a
                        // warning, never an aborted extraction.
                        _warnings.DeferException(
                            WarningSeverity.Warning, WarningCodes.PropertyReadFailed, ex, objectId);
                    }
                }
            }
            catch (Exception ex)
            {
                _warnings.DeferException(WarningSeverity.Warning, WarningCodes.CategoryReadFailed, ex, objectId);
            }
        }

        // ------------------------------------------------------- authoring id

        /// <summary>
        /// One well-known way an authoring tool names its own object.
        /// <para>
        /// A rule matches when every component it states matches. Internal names
        /// are compared ordinally because they are API identifiers; display names
        /// are compared case-insensitively because they are localised UI strings
        /// and their casing is not a promise.
        /// </para>
        /// </summary>
        private sealed class AuthoringIdRule
        {
            internal AuthoringIdRule(
                string kind, string categoryInternal, string nameInternal,
                string categoryDisplay, string nameDisplay)
            {
                Kind = kind;
                CategoryInternal = categoryInternal;
                NameInternal = nameInternal;
                CategoryDisplay = categoryDisplay;
                NameDisplay = nameDisplay;
            }

            internal string Kind { get; private set; }

            internal string CategoryInternal { get; private set; }

            internal string NameInternal { get; private set; }

            internal string CategoryDisplay { get; private set; }

            internal string NameDisplay { get; private set; }

            internal bool Matches(PropertyRecord property)
            {
                return MatchesOrdinal(CategoryInternal, property.CategoryInternal) &&
                    MatchesOrdinal(NameInternal, property.NameInternal) &&
                    MatchesDisplay(CategoryDisplay, property.Category) &&
                    MatchesDisplay(NameDisplay, property.Name);
            }

            private static bool MatchesOrdinal(string expected, string actual)
            {
                return expected == null || string.Equals(expected, actual, StringComparison.Ordinal);
            }

            private static bool MatchesDisplay(string expected, string actual)
            {
                return expected == null || string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase);
            }
        }

        /// <summary>
        /// The pairs that are an authoring tool's own object id, strongest first.
        /// <para>
        /// Deliberately a short, named list rather than a heuristic. Everything
        /// here is a documented identifier of a specific authoring tool, and
        /// <c>authoring_id_kind</c> records which one answered -- because a Revit
        /// ElementId and a DWG handle can be the same digits and mean different
        /// objects, and an identity tier that could not tell them apart would
        /// merge two pieces of equipment.
        /// </para>
        /// <para>
        /// What is deliberately NOT here: <c>LcOaNode &gt; LcOaSceneBaseUserName</c>,
        /// the generic node name. It is the item's display name wearing an
        /// internal spelling -- not an id, not unique, and free to change when
        /// somebody renames something.
        /// </para>
        /// <para>
        /// VERIFY-ON-WINDOWS (FULLY OPEN): every spelling below is compared as a
        /// string, so the compiler never sees any of it. A wrong spelling shows
        /// up on Windows as authoring_id staying null on a model that plainly has
        /// Revit element ids -- which the property catalog will show.
        /// </para>
        /// </summary>
        private static readonly AuthoringIdRule[] AuthoringIdRules =
        {
            // Revit, by internal name: the pair Navisworks writes for an exported
            // Revit element, and the only one of these that is not localised.
            new AuthoringIdRule(
                AuthoringIdKinds.RevitElementId,
                "LcRevitData_Element", "LcRevitPropertyElementId", null, null),

            // The same value under its display spelling, for a model whose
            // internal names did not survive the round trip.
            new AuthoringIdRule(AuthoringIdKinds.RevitElementId, null, null, "Element", "Id"),

            // Revit's cross-export identifier. Below the element id only because
            // it is the rarer of the two in an exported NWC; where both exist a
            // site is free to prefer this one through a stable-id property.
            new AuthoringIdRule(AuthoringIdKinds.RevitUniqueId, null, null, "Element", "UniqueId"),
            new AuthoringIdRule(AuthoringIdKinds.RevitUniqueId, null, null, "Element", "GUID"),

            // IFC, whose GlobalId is an identifier by specification.
            new AuthoringIdRule(AuthoringIdKinds.IfcGlobalId, null, null, null, "GlobalId"),

            // AutoCAD/DWG entity handles.
            new AuthoringIdRule(AuthoringIdKinds.DwgHandle, "LcOaNode", null, null, "Handle"),
            new AuthoringIdRule(AuthoringIdKinds.DwgHandle, null, null, null, "Entity Handle"),
        };

        /// <summary>
        /// The strongest authoring id among the properties just collected, and
        /// which rule found it. Both null when none matched.
        /// <para>
        /// Rules are the outer loop, properties the inner one, so the answer is
        /// the strongest RULE rather than whichever matching property happened to
        /// be read first.
        /// </para>
        /// </summary>
        private string FindAuthoringId(out string kind)
        {
            for (int r = 0; r < AuthoringIdRules.Length; r++)
            {
                AuthoringIdRule rule = AuthoringIdRules[r];
                for (int p = 0; p < _itemProperties.Count; p++)
                {
                    PropertyRecord property = _itemProperties[p];
                    string value = SafeString(property.ValueText);
                    if (value == null)
                    {
                        // A property that exists with no value names nothing.
                        continue;
                    }

                    if (rule.Matches(property))
                    {
                        kind = rule.Kind;
                        return value.Trim();
                    }
                }
            }

            kind = null;
            return null;
        }

        // ------------------------------------------------------------ helpers

        private static string SafeString(string value)
        {
            return string.IsNullOrEmpty(value) ? null : value;
        }

        /// <summary>
        /// File name, never a directory. Null for anything unusable -- on .NET
        /// Framework a path with invalid characters throws here, and a malformed
        /// path must not cost the whole extraction.
        /// </summary>
        private static string FileNameOnly(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return null;
            }

            try
            {
                return SafeString(Path.GetFileName(path));
            }
            catch (ArgumentException)
            {
                return null;
            }
        }

        private sealed class Frame
        {
            internal Frame(
                ModelItem item, long? parentId, int pathIndex, int depth,
                long sourceModelId, string parentStructuralKey)
            {
                Item = item;
                ParentId = parentId;
                PathIndex = pathIndex;
                Depth = depth;
                SourceModelId = sourceModelId;
                ParentStructuralKey = parentStructuralKey;
            }

            internal ModelItem Item { get; private set; }

            internal long? ParentId { get; private set; }

            internal int PathIndex { get; private set; }

            internal int Depth { get; private set; }

            /// <summary>
            /// The model this item belongs to, which is the enclosing model
            /// unless an ancestor opened an appended one.
            /// </summary>
            internal long SourceModelId { get; private set; }

            /// <summary>Null at the root of a walked model; a hex digest below it.</summary>
            internal string ParentStructuralKey { get; private set; }
        }
    }
}
