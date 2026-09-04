// =============================== NOT SHIPPED ===============================
// Compile-only stand-in for Autodesk.Navisworks.Api.
//
// Purpose: let `dotnet build -p:UseNavisworksStubs=true` type-check the version
// adapters (native/navisworks-2024, -2025, -2026, all compiled from the shared
// source in native/navisworks-adapter) on a machine with no Navisworks. Nothing
// here runs; every member throws. The one exception is the attribute types in
// NavisworksPluginStubs.cs, whose values are baked into metadata by the
// compiler, so their setters are never executed at all.
//
// Scope rule: a member appears here ONLY because native/navisworks-adapter
// names it. Do not "complete" the API surface -- an unused stub is an
// unverifiable guess with no compile check behind it. The adapter source is
// shared verbatim across years, so one stub set serves all three; a member that
// exists for only one year would need that year's file split out first.
// The one member the plugin still reaches reflectively is the source-model GUID
// (Model.SourceGuid/Guid/ModelGuid); Model.SourceGuid is now ALSO read directly,
// so the probe finds something in a stub run, which is a property of this file
// and not evidence about the real API. Application.Version used to be reached
// reflectively and is not any more -- the plugin names Application.Version.Runtime,
// so a wrong guess is now a compile error. See docs/WINDOWS-RUNBOOK.md.
// ===========================================================================

using System;
using System.Collections;
using System.Collections.Generic;

namespace Autodesk.Navisworks.Api
{
    /// <summary>Stub. Entry point the plugin reads the active document from.</summary>
    public static class Application
    {
        /// <summary>
        /// Assumed: a static property returning the open <see cref="Document"/>.
        /// </summary>
        public static Document ActiveDocument
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: a static property whose value has a string <c>Runtime</c>.
        /// <para>
        /// VERIFY-ON-WINDOWS: the plugin writes <c>Application.Version.Runtime</c>
        /// into meta.navisworks_version, so the member PATH is pinned by
        /// compilation. The stub type's own name is not -- the plugin never
        /// spells it -- which is why it is declared as its own class here rather
        /// than guessed at.
        /// </para>
        /// </summary>
        public static ApplicationVersion Version
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: the product's own title, e.g. "Autodesk Navisworks Manage
        /// 2025". Used only as the fallback when Version.Runtime says nothing.
        /// </summary>
        public static string Title
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>
    /// Stub. Whatever <c>Application.Version</c> returns. Only <c>Runtime</c> is
    /// pinned, because it is the only member the plugin names.
    /// </summary>
    public class ApplicationVersion
    {
        public string Runtime
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>Stub. The open Navisworks document.</summary>
    public class Document
    {
        /// <summary>Assumed: flat collection of appended source models, with a Count.</summary>
        public ModelCollection Models
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: saved selection sets, rooted at a folder.</summary>
        public DocumentSelectionSets SelectionSets
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: full path of the currently open file.</summary>
        public string FileName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: the document's display units. The plugin only calls
        /// ToString() on it, so the member NAMES of <see cref="Units"/> are not
        /// pinned by compilation -- see VariantFormatter for the same pattern.
        /// </summary>
        public Units Units
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: void OpenFile(string), no other required arguments, which
        /// throws on failure carrying Navisworks's own message.
        /// <para>
        /// The throwing form rather than the bool-returning TryOpenFile on
        /// purpose: the message is what tells a too-new file from an unreadable
        /// one, and a bool has nowhere to put it (see MatchlineExtractAddIn).
        /// </para>
        /// </summary>
        public void OpenFile(string fileName)
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>
    /// Stub. Document display units. Names mirror what Navisworks is expected to
    /// call them, but nothing compares them: the plugin writes the ToString() of
    /// this value into meta.units.
    /// </summary>
    public enum Units
    {
        Meters = 0,
        Centimeters,
        Millimeters,
        Feet,
        Inches,
        Yards,
        Kilometers,
        Miles,
        Micrometers,
        Mils,
        Microinches,
    }

    /// <summary>Stub. Enumerable of <see cref="Model"/> with a count.</summary>
    public class ModelCollection : IEnumerable<Model>
    {
        public int Count
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public IEnumerator<Model> GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        IEnumerator IEnumerable.GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>Stub. One appended source model.</summary>
    public class Model
    {
        /// <summary>Assumed: the appended file's path as recorded in the NWD.</summary>
        public string FileName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: the path of the file this model was converted FROM -- the
        /// .rvt or .dwg behind a .nwc. Distinct from <see cref="FileName"/>,
        /// which is what Navisworks itself read.
        /// </summary>
        public string SourceFileName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: a System.Guid, not a string -- the walker compares it to
        /// Guid.Empty and formats it with "D". It is ALSO one of the three names
        /// ReadModelGuid probes reflectively, and declaring it here means the
        /// probe now finds something in a stub run; that is a property of the
        /// stub, not evidence about the real API.
        /// </summary>
        public Guid SourceGuid
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: the model's root tree item.</summary>
        public ModelItem RootItem
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>
    /// Stub. One node of the model tree.
    /// <para>
    /// Reference type on purpose: the walker uses it as a
    /// <c>Dictionary&lt;ModelItem, long&gt;</c> key. Value equality is NOT
    /// stubbed (this inherits reference equality), so the stub build cannot and
    /// does not check that selection-set membership resolves.
    /// </para>
    /// </summary>
    public class ModelItem
    {
        public string DisplayName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: the human-readable class/category name.</summary>
        public string ClassDisplayName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: the internal class name.</summary>
        public string ClassName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: a System.Guid, not a string.</summary>
        public Guid InstanceGuid
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: this item is hidden in the model. Whether it also reports
        /// true for an item hidden only by an ancestor is NOT pinned; the cache
        /// records the answer and draws no conclusion from it.
        /// </summary>
        public bool IsHidden
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: the item is a layer/level node.</summary>
        public bool IsLayer
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: the item is an inserted block/instance.</summary>
        public bool IsInsert
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: the item is a composite object.</summary>
        public bool IsComposite
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: the item is a collection of other items.</summary>
        public bool IsCollection
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: the item is the root of an appended model, and
        /// <see cref="Model"/> is that model. NOT pinned, and load-bearing:
        /// whether it is true for anything other than an appended file's root.
        /// </summary>
        public bool HasModel
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: the appended model this item carries, or null.</summary>
        public Model Model
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: direct children in document order.</summary>
        public ModelItemEnumerableCollection Children
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: property categories in encounter order.</summary>
        public PropertyCategoryCollection PropertyCategories
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: a METHOD, not a property, returning a nullable reference.</summary>
        public BoundingBox3D BoundingBox()
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>Stub. Lazily enumerated child items.</summary>
    public class ModelItemEnumerableCollection : IEnumerable<ModelItem>
    {
        public IEnumerator<ModelItem> GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        IEnumerator IEnumerable.GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>Stub. Materialised collection of model items.</summary>
    public class ModelItemCollection : IEnumerable<ModelItem>
    {
        public IEnumerator<ModelItem> GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        IEnumerator IEnumerable.GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>Stub. Axis-aligned bounds. Reference type: the walker null-checks it.</summary>
    public class BoundingBox3D
    {
        /// <summary>
        /// Assumed: the box has no extent. It is what gates the write now, in
        /// place of ModelItem.HasGeometry -- a composite item has bounds without
        /// having geometry of its own.
        /// </summary>
        public bool IsEmpty
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public Point3D Min
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public Point3D Max
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>Stub. A point in model space.</summary>
    public class Point3D
    {
        public double X
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public double Y
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public double Z
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>Stub. Enumerable of property categories.</summary>
    public class PropertyCategoryCollection : IEnumerable<PropertyCategory>
    {
        public IEnumerator<PropertyCategory> GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        IEnumerator IEnumerable.GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>Stub. One property category on an item.</summary>
    public class PropertyCategory
    {
        public string DisplayName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public string Name
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public DataPropertyCollection Properties
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>Stub. Enumerable of properties within a category.</summary>
    public class DataPropertyCollection : IEnumerable<DataProperty>
    {
        public IEnumerator<DataProperty> GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        IEnumerator IEnumerable.GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>Stub. One property.</summary>
    public class DataProperty
    {
        public string DisplayName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public string Name
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>Assumed: a reference type, so a null value is representable.</summary>
        public VariantData Value
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>
    /// Stub. Discriminated property value.
    /// <para>
    /// The plugin dispatches on <c>DataType.ToString()</c> rather than on enum
    /// members, so the member names in <see cref="VariantDataType"/> are NOT
    /// pinned by compilation -- a wrong name here is invisible to the compiler
    /// and shows up on Windows as values landing in the default arm.
    /// </para>
    /// </summary>
    public class VariantData
    {
        public VariantDataType DataType
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public string ToDisplayString()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public string ToIdentifierString()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public int ToInt32()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public double ToDouble()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public double ToDoubleLength()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public double ToDoubleAngle()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public double ToDoubleArea()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public double ToDoubleVolume()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public bool ToBoolean()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public DateTime ToDateTime()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        public NamedConstant ToNamedConstant()
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>
    /// Stub. Names mirror the strings in VariantFormatter's switch, but nothing
    /// compares them: the plugin switches on the ToString() of this value.
    /// </summary>
    public enum VariantDataType
    {
        None = 0,
        DisplayString,
        IdentifierString,
        Int32,
        Double,
        DoubleLength,
        DoubleAngle,
        DoubleArea,
        DoubleVolume,
        Boolean,
        DateTime,
        NamedConstant,
        Point3D,
    }

    /// <summary>Stub. Enumerated-constant property value.</summary>
    public class NamedConstant
    {
        public string DisplayName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>Stub. The document's saved selection sets.</summary>
    public class DocumentSelectionSets
    {
        /// <summary>Assumed: a FolderItem at the root of the saved-set tree.</summary>
        public FolderItem RootItem
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>Stub. Base of everything in the saved-set tree.</summary>
    public class SavedItem
    {
        public string DisplayName
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: a System.Guid, not a string -- the walker compares it to
        /// Guid.Empty and formats it with "D". NOT pinned: that it survives a
        /// rename and a save, which is the only reason it is recorded.
        /// </summary>
        public Guid Guid
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>Stub. A saved item that can contain others.</summary>
    public class GroupItem : SavedItem
    {
        public SavedItemCollection Children
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>Stub. Folder in the saved-set tree.</summary>
    public class FolderItem : GroupItem
    {
    }

    /// <summary>
    /// Stub. A saved selection or search.
    /// <para>
    /// Assumed NOT to derive from <see cref="GroupItem"/>: the walker relies on
    /// <c>child as GroupItem</c> returning null for a selection set so it does
    /// not recurse into one. If the real type derives from GroupItem this still
    /// compiles and misbehaves at runtime -- the stub cannot catch that.
    /// </para>
    /// </summary>
    public class SelectionSet : SavedItem
    {
        /// <summary>Assumed: distinguishes a fixed selection from a saved search.</summary>
        public bool HasExplicitModelItems
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        public ModelItemCollection ExplicitModelItems
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: the items this set currently selects, evaluated -- the same
        /// answer the Navisworks UI shows for the set. Asked before the search is
        /// re-run. NOT pinned: that it evaluates anything at all in a -NoGUI
        /// session, which is why an empty answer falls through to the search
        /// rather than being believed.
        /// </summary>
        public ModelItemCollection GetSelectedItems()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        /// <summary>Assumed: true when this set is a saved search rather than a fixed list.</summary>
        public bool HasSearch
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }

        /// <summary>
        /// Assumed: the saved search itself, as a reference type so the walker's
        /// null check is meaningful.
        /// </summary>
        public Search Search
        {
            get { throw new NotImplementedException(StubMessage.Text); }
        }
    }

    /// <summary>
    /// Stub. A saved search, run to resolve a Search Set's membership.
    /// <para>
    /// Declared because DocumentWalker calls it directly rather than
    /// reflectively: a wrong member name here becomes a compile error on the
    /// first Windows build, which is the cheap failure. What the stub cannot
    /// check is any of the semantics -- whether the bool argument means "do not
    /// also select the results", and whether a search can run at all inside a
    /// -NoGUI session. See docs/WINDOWS-RUNBOOK.md.
    /// </para>
    /// </summary>
    public class Search
    {
        /// <summary>
        /// Assumed: FindAll(Document, bool) returning a materialised collection
        /// of the items that matched, and a reference type so a null answer is
        /// distinguishable from an empty one. The bool is assumed to be
        /// <c>includeHidden</c>, and the walker passes true to match its own
        /// traversal; see DocumentWalker.TryResolveSearchMembers.
        /// </summary>
        public ModelItemCollection FindAll(Document document, bool includeHidden)
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>Stub. Enumerable of saved items.</summary>
    public class SavedItemCollection : IEnumerable<SavedItem>
    {
        public IEnumerator<SavedItem> GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }

        IEnumerator IEnumerable.GetEnumerator()
        {
            throw new NotImplementedException(StubMessage.Text);
        }
    }

    /// <summary>Shared text so a stub that somehow gets executed says why it failed.</summary>
    internal static class StubMessage
    {
        internal const string Text =
            "Autodesk.Navisworks.Api here is a Matchline compile-only stub (native/navisworks-stubs). " +
            "It has no implementation. Build against a real Navisworks install.";
    }
}
