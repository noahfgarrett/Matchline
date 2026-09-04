namespace Matchline.Extraction.Records
{
    /// <summary>
    /// The record types carried by the NDJSON hand-off stream. Each line is one
    /// JSON object whose "t" field is one of these values.
    /// </summary>
    public static class NdjsonRecordType
    {
        public const string Meta = "meta";
        public const string Model = "model";
        public const string Object = "object";
        public const string Property = "prop";
        public const string SelectionSet = "set";
        public const string SelectionSetMember = "member";
        public const string Warning = "warn";

        /// <summary>
        /// One entry of <c>Document.Models</c> as the plugin found it: the file
        /// the document references and whether it actually loaded. Not a cache
        /// table -- it exists so the launcher can tell an NWF whose references
        /// all resolved from one that opened with models missing, which is the
        /// difference between a cache worth keeping and a cache that silently
        /// omits a discipline (docs/EXTRACTION.md, "NWF inputs").
        /// </summary>
        public const string Reference = "ref";

        /// <summary>
        /// A progress line from inside the Navisworks process. Not a cache
        /// table: the plugin has no channel back to the launcher, so a stage it
        /// wants reported live is written into the stream and relayed by the
        /// launcher's stream monitor (native/extractor/NdjsonProgressMonitor).
        /// </summary>
        public const string Progress = "prog";

        /// <summary>
        /// Terminator. Its presence is how the launcher knows the plugin ran to
        /// completion rather than dying mid-walk, so a truncated stream can never
        /// be mistaken for a successful extraction.
        /// </summary>
        public const string End = "end";
    }

    /// <summary>One row of the cache's <c>meta</c> key/value table.</summary>
    public sealed class MetaRecord
    {
        public string Key { get; set; }

        public string Value { get; set; }
    }

    /// <summary>One row of <c>source_models</c>.</summary>
    public sealed class SourceModelRecord
    {
        /// <summary>Extraction ordinal, 1-based, depth-first.</summary>
        public long Id { get; set; }

        public long? ParentId { get; set; }

        /// <summary>File name only, never a directory (privacy: see EXTRACTION.md).</summary>
        public string FileName { get; set; }

        public string DisplayName { get; set; }

        /// <summary>
        /// The <c>guid</c> column: the model GUID the adapter reads reflectively,
        /// because the member name for it varies by release.
        /// </summary>
        public string Guid { get; set; }

        /// <summary>
        /// The <c>source_file_name</c> column, from <c>Model.SourceFileName</c>.
        /// File name only, never a directory (privacy: see EXTRACTION.md).
        /// </summary>
        public string SourceFileName { get; set; }

        /// <summary>
        /// The <c>source_guid</c> column, from <c>Model.SourceGuid</c> read
        /// directly. Distinct from <see cref="Guid"/> on purpose: that one is a
        /// reflective probe over three candidate spellings and may answer from a
        /// different member, and a cache that carries both can say which.
        /// </summary>
        public string SourceGuid { get; set; }
    }

    /// <summary>
    /// One entry of <c>Document.Models</c>, as reported by the plugin before the
    /// walk. Not a cache row: the launcher reads these to decide whether the
    /// document opened with everything it references.
    /// </summary>
    public sealed class SourceReferenceRecord
    {
        /// <summary>File name only, never a directory.</summary>
        public string SourceFileName { get; set; }

        /// <summary>
        /// False when the reference did not come in: the model's root item has
        /// no children AND its source file is not on disk. Either alone is
        /// ordinary (an empty appended file; a file loaded from a path that has
        /// since moved), so both are required before an absence is claimed.
        /// </summary>
        public bool Loaded { get; set; }
    }

    /// <summary>One row of <c>objects</c>.</summary>
    public sealed class ObjectRecord
    {
        /// <summary>Extraction ordinal, 1-based, depth-first document order.</summary>
        public long Id { get; set; }

        public long? SourceModelId { get; set; }

        public long? ParentId { get; set; }

        /// <summary>Sibling position; (ParentId, PathIndex) is unique.</summary>
        public int PathIndex { get; set; }

        public int Depth { get; set; }

        public string DisplayName { get; set; }

        public string ClassName { get; set; }

        public string InstanceGuid { get; set; }

        public string AuthoringId { get; set; }

        /// <summary>
        /// One of <see cref="AuthoringIdKinds"/>, naming which well-known
        /// property pair produced <see cref="AuthoringId"/>. Null exactly when
        /// <see cref="AuthoringId"/> is null.
        /// </summary>
        public string AuthoringIdKind { get; set; }

        /// <summary>
        /// Lowercase SHA-256 hex over the ancestor chain of
        /// (class name, display name, path index) from the source model's root.
        /// Shape only, never content.
        /// </summary>
        public string StructuralKey { get; set; }

        /// <summary>A bitwise OR of <see cref="ObjectFlags"/>.</summary>
        public long Flags { get; set; }

        /// <summary>
        /// Six doubles (min x/y/z then max x/y/z) or null. All-or-none per row,
        /// matching the schema comment.
        /// </summary>
        public double[] BoundingBox { get; set; }
    }

    /// <summary>
    /// Values for <c>objects.authoring_id_kind</c>. The list is ordered the way
    /// <c>DocumentWalker</c> tries them, strongest first: a Revit element id is
    /// stable within a model, a Revit UniqueId is stable across exports, and an
    /// IFC GlobalId or a DWG handle is whatever the exporting tool guarantees.
    /// </summary>
    public static class AuthoringIdKinds
    {
        public const string RevitElementId = "revit-element-id";
        public const string RevitUniqueId = "revit-unique-id";
        public const string IfcGlobalId = "ifc-global-id";
        public const string DwgHandle = "dwg-handle";
    }

    /// <summary>
    /// Bits of <c>objects.flags</c>. Powers of two, appended only: a reader that
    /// does not know a bit must be able to ignore it rather than misread the
    /// ones it does know.
    /// </summary>
    public static class ObjectFlags
    {
        public const long None = 0;
        public const long Hidden = 1;
        public const long Layer = 2;
        public const long Insert = 4;
        public const long Composite = 8;
        public const long Collection = 16;
        public const long HasModel = 32;
    }

    /// <summary>One row of <c>properties</c>.</summary>
    public sealed class PropertyRecord
    {
        public long ObjectId { get; set; }

        public string Category { get; set; }

        public string CategoryInternal { get; set; }

        public string Name { get; set; }

        public string NameInternal { get; set; }

        /// <summary>Canonical, culture-invariant string form of the value.</summary>
        public string ValueText { get; set; }

        /// <summary>Navisworks VariantDataType name, e.g. 'DisplayString'.</summary>
        public string ValueType { get; set; }
    }

    /// <summary>Allowed values for <c>selection_sets.kind</c>.</summary>
    public static class SelectionSetKind
    {
        public const string Folder = "folder";
        public const string Selection = "selection";
        public const string Search = "search";
    }

    /// <summary>One row of <c>selection_sets</c>.</summary>
    public sealed class SelectionSetRecord
    {
        private bool _membershipResolved = true;

        public long Id { get; set; }

        public long? ParentId { get; set; }

        public string Name { get; set; }

        /// <summary>One of <see cref="SelectionSetKind"/>.</summary>
        public string Kind { get; set; }

        /// <summary>
        /// False when this set's membership could not be worked out, which for
        /// now means a saved search that would not run (schema v2,
        /// <c>selection_sets.membership_resolved</c>).
        /// <para>
        /// Defaults to true because folders and explicit selections always know
        /// their own membership, and because a record built by an older caller
        /// that never heard of this field is describing a set it did resolve.
        /// An unresolved set carries NO member records at all -- absent is not
        /// empty (docs/RELEASE-1.0-PLAN.md P0-3: never return empty-as-answer).
        /// </para>
        /// </summary>
        public bool MembershipResolved
        {
            get { return _membershipResolved; }
            set { _membershipResolved = value; }
        }

        /// <summary>
        /// <c>SavedItem.Guid</c>: the set's own persistent identity, which
        /// survives a rename. Null when the API would not give one up.
        /// </summary>
        public string Guid { get; set; }
    }

    /// <summary>
    /// A progress line the plugin writes into the stream for the launcher to
    /// relay. Not a cache table.
    /// </summary>
    public sealed class ProgressRecord
    {
        /// <summary>One of <c>Matchline.Extraction.Protocol.ExtractionStages</c>.</summary>
        public string Stage { get; set; }

        public long Done { get; set; }

        /// <summary>0 means unknown, exactly as on the launcher's own lines.</summary>
        public long Total { get; set; }
    }

    /// <summary>One row of <c>selection_set_members</c>.</summary>
    public sealed class SelectionSetMemberRecord
    {
        public long SetId { get; set; }

        public long ObjectId { get; set; }
    }

    /// <summary>Allowed values for <c>warnings.severity</c>.</summary>
    public static class WarningSeverity
    {
        public const string Info = "info";
        public const string Warning = "warning";
        public const string Error = "error";
    }

    /// <summary>Stable machine codes for <c>warnings.code</c>.</summary>
    public static class WarningCodes
    {
        public const string PropertyReadFailed = "PROPERTY_READ_FAILED";
        public const string CategoryReadFailed = "CATEGORY_READ_FAILED";
        public const string ItemReadFailed = "ITEM_READ_FAILED";
        public const string BoundingBoxReadFailed = "BOUNDING_BOX_READ_FAILED";
        public const string SelectionSetReadFailed = "SELECTION_SET_READ_FAILED";
        public const string SelectionSetMemberUnresolved = "SELECTION_SET_MEMBER_UNRESOLVED";

        /// <summary>
        /// A saved search whose membership could not be resolved. The set is
        /// still recorded (with <c>membership_resolved = 0</c> and no members),
        /// and this warning names it so a person can find it in Navisworks.
        /// Every unresolved set has exactly one of these.
        /// </summary>
        public const string SearchSetUnresolved = "SEARCH_SET_UNRESOLVED";
        public const string SourceModelReadFailed = "SOURCE_MODEL_READ_FAILED";

        /// <summary>
        /// A file the document references was not loaded: its model has no
        /// items and the file is not on disk. Always error severity, because a
        /// cache written from such a document is missing a whole discipline
        /// rather than a property, and the launcher refuses to commit it.
        /// </summary>
        public const string SourceModelMissing = "SOURCE_MODEL_MISSING";
    }

    /// <summary>One row of <c>warnings</c>.</summary>
    public sealed class WarningRecord
    {
        /// <summary>One of <see cref="WarningSeverity"/>.</summary>
        public string Severity { get; set; }

        /// <summary>One of <see cref="WarningCodes"/>.</summary>
        public string Code { get; set; }

        public string Message { get; set; }

        public long? ObjectId { get; set; }
    }

    /// <summary>
    /// Stream terminator. Not a cache table: it is the completeness sentinel and
    /// the plugin's only channel for reporting a fatal error, since the launcher
    /// cannot rely on Navisworks propagating a plugin's return code.
    /// </summary>
    public sealed class EndRecord
    {
        public bool Ok { get; set; }

        /// <summary>Error code when <see cref="Ok"/> is false; null otherwise.</summary>
        public string Code { get; set; }

        public string Message { get; set; }

        public long ObjectCount { get; set; }

        public long WarningCount { get; set; }
    }
}
