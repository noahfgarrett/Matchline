using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Autodesk.Navisworks.Api;
using Matchline.Extraction.Ndjson;
using Matchline.Extraction.Protocol;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.NavisworksAdapter
{
    /// <summary>
    /// Walks an open Navisworks document and streams it as NDJSON.
    /// <para>
    /// Ordering is the contract (EXTRACTION.md, design call 5): source models in
    /// document order, items depth-first pre-order with explicit sibling indices,
    /// properties in encounter order per item. The same NWD must produce the same
    /// stream every time.
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
    internal sealed class DocumentWalker
    {
        private readonly NdjsonWriter _writer;
        private readonly WarningCollector _warnings;

        /// <summary>
        /// Item -> assigned object id, used to resolve selection set membership
        /// after the tree walk.
        /// VERIFY-ON-WINDOWS (FULLY OPEN -- the stub build cannot help here):
        /// this assumes ModelItem implements value equality (Equals/GetHashCode
        /// over the underlying item), so that the instance handed back by a
        /// selection set matches the one seen during the walk. The stub declares
        /// ModelItem with plain reference equality, so a green stub build says
        /// nothing either way. If membership counts come out at zero, this is why.
        /// </summary>
        private readonly Dictionary<ModelItem, long> _objectIds = new Dictionary<ModelItem, long>();

        private long _nextObjectId = 1;

        /// <summary>Saved sets resolved so far, and how many there are. Progress only.</summary>
        private long _setsDone;

        private long _setsTotal;

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

        internal void Walk(Document document)
        {
            if (document == null)
            {
                throw new ArgumentNullException("document");
            }

            WalkSourceModels(document);
            WalkSelectionSets(document);
        }

        private void WalkSourceModels(Document document)
        {
            long modelId = 0;

            // VERIFY-ON-WINDOWS (shape pinned by the stub build): Document.Models
            // is enumerable with element type Model, and exposes .Count (used in
            // MatchlineExtractAddIn). Still unconfirmed against the real assembly.
            foreach (Model model in document.Models)
            {
                modelId++;
                int rootPathIndex = (int)(modelId - 1);

                try
                {
                    _writer.WriteSourceModel(BuildSourceModelRecord(model, modelId));
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
            }
        }

        private SourceModelRecord BuildSourceModelRecord(Model model, long modelId)
        {
            SourceModelRecord record = new SourceModelRecord();
            record.Id = modelId;

            // Nested appended models are not represented as a tree by the
            // Navisworks API: Document.Models is flat, so parent_id stays null
            // in Phase 1. The column exists for when a version adapter can fill it.
            record.ParentId = null;

            // VERIFY-ON-WINDOWS (shape pinned by the stub build: Model.FileName is
            // a string property). What is NOT pinned is the meaning: that it holds
            // the appended file's path.
            // Only the file name is recorded -- directories would leak local
            // paths into a portable cache (EXTRACTION.md, confidentiality).
            string fileName = SafeString(model.FileName);
            record.FileName = string.IsNullOrEmpty(fileName) ? null : Path.GetFileName(fileName);

            try
            {
                ModelItem root = model.RootItem;
                record.DisplayName = root == null ? null : SafeString(root.DisplayName);
            }
            catch (Exception)
            {
                record.DisplayName = null;
            }

            record.SourceGuid = ReadModelGuid(model);
            return record;
        }

        /// <summary>
        /// Source model GUID, read reflectively.
        /// <para>
        /// Deliberate: the member name for this varies by release (SourceGuid /
        /// Guid / ModelGuid) and it is descriptive metadata, not control flow.
        /// Reflection keeps a wrong guess from being a compile error on a project
        /// that cannot be compiled here, and keeps this file identical across
        /// years. VERIFY-ON-WINDOWS (FULLY OPEN): the stub build cannot check a
        /// reflective lookup, and the stub deliberately declares none of these
        /// three so as not to fake an answer. Find the real member during the
        /// proof run and replace this with the direct property.
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
        /// Depth-first pre-order walk using an explicit stack rather than
        /// recursion, so a pathologically deep model cannot overflow the stack
        /// inside the Autodesk process.
        /// </summary>
        private void WalkItems(ModelItem root, long sourceModelId, int rootPathIndex)
        {
            Stack<Frame> pending = new Stack<Frame>();
            pending.Push(new Frame(root, null, rootPathIndex, 0));

            List<ModelItem> children = new List<ModelItem>();

            while (pending.Count > 0)
            {
                Frame frame = pending.Pop();
                long objectId = _nextObjectId++;
                _objectIds[frame.Item] = objectId;

                EmitObject(frame, objectId, sourceModelId);
                EmitProperties(frame.Item, objectId);

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
                    pending.Push(new Frame(children[i], objectId, i, frame.Depth + 1));
                }
            }
        }

        /// <summary>
        /// Writes one object record, then any warnings raised while building it.
        /// <para>
        /// The order is deliberate, and the reason is in
        /// <see cref="WarningCollector"/>: a warning carrying this item's object
        /// id must not reach the stream before the row it names exists.
        /// Warnings raised after this point (properties, children) are already
        /// correctly ordered and go out immediately.
        /// </para>
        /// </summary>
        private void EmitObject(Frame frame, long objectId, long sourceModelId)
        {
            ObjectRecord record = new ObjectRecord();
            record.Id = objectId;
            record.SourceModelId = sourceModelId;
            record.ParentId = frame.ParentId;
            record.PathIndex = frame.PathIndex;
            record.Depth = frame.Depth;

            try
            {
                record.DisplayName = SafeString(frame.Item.DisplayName);

                // VERIFY-ON-WINDOWS (shape pinned by the stub build: both are
                // string properties on ModelItem). NOT pinned: which of the two is
                // the display form. The schema wants the display form.
                string className = SafeString(frame.Item.ClassDisplayName);
                if (string.IsNullOrEmpty(className))
                {
                    className = SafeString(frame.Item.ClassName);
                }

                record.ClassName = className;

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

            // authoring_id stays null in Phase 1. Authoring-tool ids (Revit
            // element id and friends) arrive as ordinary properties; promoting
            // one into a column is a mapping decision, and mapping is Phase 2.
            record.AuthoringId = null;
            record.BoundingBox = ReadBoundingBox(frame.Item, objectId);

            _writer.WriteObject(record);
            _warnings.FlushDeferred();
        }

        private double[] ReadBoundingBox(ModelItem item, long objectId)
        {
            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                // ModelItem.HasGeometry is a bool property; BoundingBox() is a
                // METHOD, not a property, returning a nullable reference type whose
                // Min/Max are Point3D with double X/Y/Z). NOT pinned: that
                // HasGeometry is cheap, which is the whole reason it gates the call.
                if (!item.HasGeometry)
                {
                    return null;
                }

                BoundingBox3D box = item.BoundingBox();
                if (box == null)
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

        private void EmitProperties(ModelItem item, long objectId)
        {
            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                // ModelItem.PropertyCategories is enumerable with element type
                // PropertyCategory). Iterated with foreach rather than assigned to
                // an interface, so the exact collection type does not have to be
                // guessed -- which is also why the stub's name for it is arbitrary.
                foreach (PropertyCategory category in item.PropertyCategories)
                {
                    EmitCategory(category, objectId);
                }
            }
            catch (Exception ex)
            {
                _warnings.WarnException(WarningSeverity.Warning, WarningCodes.CategoryReadFailed, ex, objectId);
            }
        }

        private void EmitCategory(PropertyCategory category, long objectId)
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
                _warnings.WarnException(WarningSeverity.Warning, WarningCodes.CategoryReadFailed, ex, objectId);
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

                        _writer.WriteProperty(record);
                    }
                    catch (Exception ex)
                    {
                        // Per EXTRACTION.md: a property that will not read is a
                        // warning, never an aborted extraction.
                        _warnings.WarnException(
                            WarningSeverity.Warning, WarningCodes.PropertyReadFailed, ex, objectId);
                    }
                }
            }
            catch (Exception ex)
            {
                _warnings.WarnException(WarningSeverity.Warning, WarningCodes.CategoryReadFailed, ex, objectId);
            }
        }

        private void WalkSelectionSets(Document document)
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
                        EmitSelectionSetMembers(members, setId);
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
        /// Runs a saved search and returns what it found, or false with the
        /// reason it could not.
        /// <para>
        /// This is the preferred half of RELEASE-1.0-PLAN P0-3: a Search Set is
        /// answered by resolving its real membership, not by recording the set
        /// and calling the question someone else's problem. It is also the
        /// expensive half -- the search re-runs over the whole document -- which
        /// is why the caller reports progress per set.
        /// </para>
        /// <para>
        /// VERIFY-ON-WINDOWS (shape pinned by the stub build: SelectionSet.HasSearch
        /// is a bool, SelectionSet.Search returns a Search, and
        /// Search.FindAll(Document, bool) returns something enumerable of
        /// ModelItem). FULLY OPEN, all of it semantic:
        /// </para>
        /// <para>
        /// (1) that the member is spelled <c>Search</c> and the method
        /// <c>FindAll</c> -- a wrong guess is a compile error on Windows, which
        /// is the cheap failure and the reason this is written as a direct call
        /// rather than reflectively;
        /// </para>
        /// <para>
        /// (2) that the bool argument means "do not also select the results". If
        /// it means something else, passing false is still the conservative
        /// choice for a headless run;
        /// </para>
        /// <para>
        /// (3) that a search can be run at all inside a -NoGUI session. If it
        /// cannot, every search set comes back unresolved with the exception text
        /// in its warning, which is exactly the honest fallback the plan asks
        /// for;
        /// </para>
        /// <para>
        /// (4) that the ModelItems it hands back compare equal to the ones seen
        /// during the tree walk. That is the same open question the
        /// <see cref="_objectIds"/> dictionary rests on, and here it fails
        /// differently: the set resolves, and every member lands in the
        /// unresolved-member count instead.
        /// </para>
        /// </summary>
        private static bool TryResolveSearchMembers(
            Document document, SelectionSet selectionSet, out List<ModelItem> members, out string failure)
        {
            members = new List<ModelItem>();
            failure = null;

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

                ModelItemCollection found = search.FindAll(document, false);
                if (found == null)
                {
                    failure = "the search returned nothing at all, not even an empty result.";
                    return false;
                }

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
        /// Writes one member row per item the set resolved to that the walk also
        /// saw. Items it did not see are counted and reported once: they are a
        /// membership question this cache cannot answer per item, not a set that
        /// failed to resolve.
        /// </summary>
        private void EmitSelectionSetMembers(List<ModelItem> members, long setId)
        {
            long unresolved = 0;
            foreach (ModelItem member in members)
            {
                long objectId;
                if (member != null && _objectIds.TryGetValue(member, out objectId))
                {
                    SelectionSetMemberRecord record = new SelectionSetMemberRecord();
                    record.SetId = setId;
                    record.ObjectId = objectId;
                    _writer.WriteSelectionSetMember(record);
                }
                else
                {
                    unresolved++;
                }
            }

            if (unresolved > 0)
            {
                _warnings.Warn(
                    WarningSeverity.Warning,
                    WarningCodes.SelectionSetMemberUnresolved,
                    unresolved.ToString(CultureInfo.InvariantCulture) +
                    " member(s) of set id " + setId.ToString(CultureInfo.InvariantCulture) +
                    " did not match any walked item.",
                    null);
            }
        }

        private static string SafeString(string value)
        {
            return string.IsNullOrEmpty(value) ? null : value;
        }

        private sealed class Frame
        {
            internal Frame(ModelItem item, long? parentId, int pathIndex, int depth)
            {
                Item = item;
                ParentId = parentId;
                PathIndex = pathIndex;
                Depth = depth;
            }

            internal ModelItem Item { get; private set; }

            internal long? ParentId { get; private set; }

            internal int PathIndex { get; private set; }

            internal int Depth { get; private set; }
        }
    }
}
