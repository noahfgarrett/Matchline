namespace Matchline.Extraction.Ndjson
{
    /// <summary>
    /// Field names used on the wire. Kept in one place so the writer (plugin side)
    /// and the reader (launcher side) cannot drift apart.
    /// </summary>
    internal static class NdjsonFields
    {
        internal const string Type = "t";

        // meta
        internal const string MetaKey = "k";
        internal const string MetaValue = "v";

        // shared
        internal const string Id = "id";
        internal const string ParentId = "parent";
        internal const string Name = "name";

        // model
        internal const string FileName = "file";
        internal const string Guid = "guid";

        // object
        internal const string ModelId = "model";
        internal const string PathIndex = "idx";
        internal const string Depth = "depth";
        internal const string ClassName = "class";
        internal const string InstanceGuid = "iguid";
        internal const string AuthoringId = "aid";
        internal const string BoundingBox = "bbox";

        // property
        internal const string ObjectId = "obj";
        internal const string Category = "cat";
        internal const string CategoryInternal = "cati";
        internal const string NameInternal = "namei";
        internal const string Value = "val";
        internal const string ValueType = "vt";

        // selection set
        internal const string Kind = "kind";
        internal const string SetId = "set";
        internal const string MembershipResolved = "res";

        // progress
        internal const string Stage = "stage";
        internal const string Done = "done";
        internal const string Total = "total";

        // warning
        internal const string Severity = "sev";
        internal const string Code = "code";
        internal const string Message = "msg";

        // end
        internal const string Ok = "ok";
        internal const string ObjectCount = "objects";
        internal const string WarningCount = "warnings";
    }
}
