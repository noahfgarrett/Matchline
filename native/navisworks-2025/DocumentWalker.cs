using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Autodesk.Navisworks.Api;
using Matchline.Extraction.Ndjson;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Navisworks2025
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
    /// Failure policy: a per-item or per-property read failure becomes a warning
    /// record and the walk continues. Only a failure that makes the whole walk
    /// meaningless propagates out.
    /// </para>
    /// </summary>
    internal sealed class DocumentWalker
    {
        private readonly NdjsonWriter _writer;

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
        private long _warningCount;

        internal DocumentWalker(NdjsonWriter writer)
        {
            if (writer == null)
            {
                throw new ArgumentNullException("writer");
            }

            _writer = writer;
        }

        internal long ObjectCount
        {
            get { return _nextObjectId - 1; }
        }

        internal long WarningCount
        {
            get { return _warningCount; }
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
                    Warn(WarningSeverity.Warning, WarningCodes.SourceModelReadFailed, Describe(ex), null);
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
                    Warn(WarningSeverity.Error, WarningCodes.SourceModelReadFailed, Describe(ex), null);
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
        /// that cannot be compiled here. VERIFY-ON-WINDOWS (FULLY OPEN): the stub
        /// build cannot check a reflective lookup, and the stub deliberately
        /// declares none of these three so as not to fake an answer. Find the real
        /// member during the proof run and replace this with the direct property.
        /// </para>
        /// </summary>
        private static string ReadModelGuid(Model model)
        {
            string[] candidates = { "SourceGuid", "Guid", "ModelGuid" };
            for (int i = 0; i < candidates.Length; i++)
            {
                try
                {
                    System.Reflection.PropertyInfo property = typeof(Model).GetProperty(candidates[i]);
                    if (property == null)
                    {
                        continue;
                    }

                    object value = property.GetValue(model, null);
                    if (value == null)
                    {
                        continue;
                    }

                    string text = value.ToString();
                    if (string.IsNullOrEmpty(text) || text == Guid.Empty.ToString())
                    {
                        continue;
                    }

                    return text;
                }
                catch (Exception)
                {
                    // Try the next candidate.
                }
            }

            return null;
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
                    Warn(WarningSeverity.Warning, WarningCodes.ItemReadFailed, Describe(ex), objectId);
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
        /// The order is deliberate. Reading an item's fields or its bounding box
        /// can fail, and those warnings carry the item's object id; emitting them
        /// first would put a <c>warnings</c> row referencing an <c>objects</c> row
        /// that does not exist yet. The cache is written with
        /// <c>PRAGMA foreign_keys</c> at its default of OFF, so today that is
        /// only latent, but it makes the stream unreplayable against a cache with
        /// enforcement on and it is free to avoid. Warnings raised after this
        /// point (properties, children) are already correctly ordered.
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

            List<WarningRecord> deferred = null;

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
                Defer(ref deferred, WarningSeverity.Warning, WarningCodes.ItemReadFailed, Describe(ex), objectId);
            }

            // authoring_id stays null in Phase 1. Authoring-tool ids (Revit
            // element id and friends) arrive as ordinary properties; promoting
            // one into a column is a mapping decision, and mapping is Phase 2.
            record.AuthoringId = null;
            record.BoundingBox = ReadBoundingBox(frame.Item, objectId, ref deferred);

            _writer.WriteObject(record);

            if (deferred != null)
            {
                for (int i = 0; i < deferred.Count; i++)
                {
                    Emit(deferred[i]);
                }
            }
        }

        private double[] ReadBoundingBox(ModelItem item, long objectId, ref List<WarningRecord> deferred)
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
                Defer(ref deferred, WarningSeverity.Info, WarningCodes.BoundingBoxReadFailed, Describe(ex), objectId);
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
                Warn(WarningSeverity.Warning, WarningCodes.CategoryReadFailed, Describe(ex), objectId);
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
                Warn(WarningSeverity.Warning, WarningCodes.CategoryReadFailed, Describe(ex), objectId);
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
                        Warn(WarningSeverity.Warning, WarningCodes.PropertyReadFailed, Describe(ex), objectId);
                    }
                }
            }
            catch (Exception ex)
            {
                Warn(WarningSeverity.Warning, WarningCodes.CategoryReadFailed, Describe(ex), objectId);
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
                Warn(WarningSeverity.Warning, WarningCodes.SelectionSetReadFailed, Describe(ex), null);
                return;
            }

            if (root == null)
            {
                return;
            }

            long nextSetId = 1;
            WalkSavedItemChildren(root, null, ref nextSetId);
        }

        private void WalkSavedItemChildren(SavedItem parent, long? parentSetId, ref long nextSetId)
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
                Warn(WarningSeverity.Warning, WarningCodes.SelectionSetReadFailed, Describe(ex), null);
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
                        _writer.WriteSelectionSet(record);
                        WalkSavedItemChildren(child, setId, ref nextSetId);
                        continue;
                    }

                    // VERIFY-ON-WINDOWS (shape pinned by the stub build: a bool
                    // property on SelectionSet). NOT pinned: that it means "fixed
                    // selection rather than saved search".
                    bool isExplicit = selectionSet.HasExplicitModelItems;
                    record.Kind = isExplicit ? SelectionSetKind.Selection : SelectionSetKind.Search;
                    _writer.WriteSelectionSet(record);

                    if (isExplicit)
                    {
                        EmitSelectionSetMembers(selectionSet, setId);
                    }
                    else
                    {
                        // Resolving a saved search means re-running it over the
                        // whole model, which can cost minutes on a large NWD.
                        // Phase 1 records the set and leaves membership to the
                        // reading side.
                        Warn(
                            WarningSeverity.Info,
                            WarningCodes.SearchSetNotResolved,
                            "Search set '" + record.Name + "' recorded without members.",
                            null);
                    }
                }
                catch (Exception ex)
                {
                    Warn(WarningSeverity.Warning, WarningCodes.SelectionSetReadFailed, Describe(ex), null);
                }
            }
        }

        private void EmitSelectionSetMembers(SelectionSet selectionSet, long setId)
        {
            List<ModelItem> members = new List<ModelItem>();
            try
            {
                // VERIFY-ON-WINDOWS (shape pinned by the stub build:
                // SelectionSet.ExplicitModelItems is enumerable with element type
                // ModelItem).
                foreach (ModelItem member in selectionSet.ExplicitModelItems)
                {
                    members.Add(member);
                }
            }
            catch (Exception ex)
            {
                Warn(WarningSeverity.Warning, WarningCodes.SelectionSetReadFailed, Describe(ex), null);
                return;
            }

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
                Warn(
                    WarningSeverity.Warning,
                    WarningCodes.SelectionSetMemberUnresolved,
                    unresolved.ToString(CultureInfo.InvariantCulture) +
                    " member(s) of set id " + setId.ToString(CultureInfo.InvariantCulture) +
                    " did not match any walked item.",
                    null);
            }
        }

        private void Warn(string severity, string code, string message, long? objectId)
        {
            Emit(Build(severity, code, message, objectId));
        }

        /// <summary>
        /// Queues a warning that must not be written until the object row it
        /// references exists. See <see cref="EmitObject"/>.
        /// </summary>
        private static void Defer(
            ref List<WarningRecord> deferred, string severity, string code, string message, long? objectId)
        {
            if (deferred == null)
            {
                deferred = new List<WarningRecord>();
            }

            deferred.Add(Build(severity, code, message, objectId));
        }

        private static WarningRecord Build(string severity, string code, string message, long? objectId)
        {
            WarningRecord record = new WarningRecord();
            record.Severity = severity;
            record.Code = code;
            record.Message = message ?? string.Empty;
            record.ObjectId = objectId;
            return record;
        }

        private void Emit(WarningRecord record)
        {
            // Counted on emit, not on creation, so the count in the end record
            // always equals the number of warning lines in the stream.
            _warningCount++;
            _writer.WriteWarning(record);
        }

        private static string SafeString(string value)
        {
            return string.IsNullOrEmpty(value) ? null : value;
        }

        private static string Describe(Exception ex)
        {
            if (ex == null)
            {
                return "unknown failure";
            }

            return ex.GetType().Name + ": " + ex.Message;
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
