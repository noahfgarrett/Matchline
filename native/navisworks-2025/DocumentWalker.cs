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
        /// VERIFY-ON-WINDOWS: this assumes ModelItem implements value equality
        /// (Equals/GetHashCode over the underlying item), so that the instance
        /// handed back by a selection set matches the one seen during the walk.
        /// If membership counts come out at zero, this is why.
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

            // VERIFY-ON-WINDOWS: Document.Models enumerates as Model.
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
                    // VERIFY-ON-WINDOWS: Model.RootItem.
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

            // VERIFY-ON-WINDOWS: Model.FileName holds the appended file's path.
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
        /// that cannot be compiled here. VERIFY-ON-WINDOWS: find the real member
        /// during the proof run and replace this with the direct property.
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
                    // VERIFY-ON-WINDOWS: ModelItem.Children enumerates child items
                    // in document order.
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

                // VERIFY-ON-WINDOWS: ModelItem.ClassDisplayName (display) and
                // ModelItem.ClassName (internal). The schema wants the display form.
                string className = SafeString(frame.Item.ClassDisplayName);
                if (string.IsNullOrEmpty(className))
                {
                    className = SafeString(frame.Item.ClassName);
                }

                record.ClassName = className;

                // VERIFY-ON-WINDOWS: ModelItem.InstanceGuid is a System.Guid.
                Guid instanceGuid = frame.Item.InstanceGuid;
                record.InstanceGuid = instanceGuid == Guid.Empty
                    ? null
                    : instanceGuid.ToString("D", CultureInfo.InvariantCulture);
            }
            catch (Exception ex)
            {
                Warn(WarningSeverity.Warning, WarningCodes.ItemReadFailed, Describe(ex), objectId);
            }

            // authoring_id stays null in Phase 1. Authoring-tool ids (Revit
            // element id and friends) arrive as ordinary properties; promoting
            // one into a column is a mapping decision, and mapping is Phase 2.
            record.AuthoringId = null;
            record.BoundingBox = ReadBoundingBox(frame.Item, objectId);

            _writer.WriteObject(record);
        }

        private double[] ReadBoundingBox(ModelItem item, long objectId)
        {
            try
            {
                // VERIFY-ON-WINDOWS: ModelItem.HasGeometry gates the cost, and
                // ModelItem.BoundingBox() returns a BoundingBox3D with Min/Max
                // Point3D. "Where cheap" means: only for items that own geometry.
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
                Warn(WarningSeverity.Info, WarningCodes.BoundingBoxReadFailed, Describe(ex), objectId);
                return null;
            }
        }

        private void EmitProperties(ModelItem item, long objectId)
        {
            try
            {
                // VERIFY-ON-WINDOWS: ModelItem.PropertyCategories.
                // Iterated with foreach rather than assigned to an interface, so
                // the exact collection type does not have to be guessed.
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
                // VERIFY-ON-WINDOWS: PropertyCategory.DisplayName (display)
                // and PropertyCategory.Name (internal).
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
                // VERIFY-ON-WINDOWS: PropertyCategory.Properties.
                foreach (DataProperty property in category.Properties)
                {
                    try
                    {
                        PropertyRecord record = new PropertyRecord();
                        record.ObjectId = objectId;
                        record.Category = categoryDisplay ?? string.Empty;
                        record.CategoryInternal = categoryInternal;

                        // VERIFY-ON-WINDOWS: DataProperty.DisplayName / .Name / .Value.
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
                // VERIFY-ON-WINDOWS: Document.SelectionSets.RootItem is a
                // FolderItem holding the saved-set tree.
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
            // VERIFY-ON-WINDOWS: GroupItem.Children (FolderItem derives from
            // GroupItem). A SelectionSet is not a GroupItem and has no children.
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

                    // VERIFY-ON-WINDOWS: SelectionSet.HasExplicitModelItems
                    // distinguishes a fixed selection from a saved search.
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
                // VERIFY-ON-WINDOWS: SelectionSet.ExplicitModelItems.
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
            _warningCount++;
            WarningRecord record = new WarningRecord();
            record.Severity = severity;
            record.Code = code;
            record.Message = message ?? string.Empty;
            record.ObjectId = objectId;
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
