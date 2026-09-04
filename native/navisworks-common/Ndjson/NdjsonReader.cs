using System;
using System.IO;
using System.Text;
using Matchline.Extraction.Json;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Ndjson
{
    /// <summary>
    /// One parsed line of the hand-off stream. Exactly one payload property is
    /// non-null, chosen by <see cref="Type"/>; an unrecognised type leaves them
    /// all null so a future record kind is skipped rather than fatal.
    /// </summary>
    public sealed class NdjsonEntry
    {
        public string Type { get; set; }

        /// <summary>1-based line number in the stream, for diagnostics.</summary>
        public long LineNumber { get; set; }

        public MetaRecord Meta { get; set; }

        public SourceModelRecord SourceModel { get; set; }

        public SourceReferenceRecord SourceReference { get; set; }

        public ObjectRecord Object { get; set; }

        public PropertyRecord Property { get; set; }

        public SelectionSetRecord SelectionSet { get; set; }

        public SelectionSetMemberRecord SelectionSetMember { get; set; }

        public WarningRecord Warning { get; set; }

        public ProgressRecord Progress { get; set; }

        public EndRecord End { get; set; }
    }

    /// <summary>
    /// Reads the extraction hand-off stream produced by <see cref="NdjsonWriter"/>.
    /// Used by the launcher only.
    /// </summary>
    public sealed class NdjsonReader : IDisposable
    {
        private const int BufferBytes = 1 << 16;

        private readonly TextReader _reader;
        private readonly bool _ownsReader;
        private long _lineNumber;
        private bool _disposed;

        public NdjsonReader(TextReader reader, bool ownsReader)
        {
            if (reader == null)
            {
                throw new ArgumentNullException("reader");
            }

            _reader = reader;
            _ownsReader = ownsReader;
        }

        public static NdjsonReader OpenFile(string path)
        {
            FileStream stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                BufferBytes,
                FileOptions.SequentialScan);

            StreamReader reader = null;
            try
            {
                reader = new StreamReader(stream, new UTF8Encoding(false), false, BufferBytes);
                return new NdjsonReader(reader, true);
            }
            catch
            {
                if (reader != null)
                {
                    reader.Dispose();
                }
                else
                {
                    stream.Dispose();
                }

                throw;
            }
        }

        /// <summary>
        /// Reads the next entry, or returns null at end of stream. Throws
        /// <see cref="JsonParseException"/> on a malformed line -- which is also
        /// what a stream truncated by a killed plugin looks like.
        /// </summary>
        public NdjsonEntry ReadNext()
        {
            while (true)
            {
                string line = _reader.ReadLine();
                if (line == null)
                {
                    return null;
                }

                _lineNumber++;
                if (line.Length == 0)
                {
                    continue;
                }

                return Materialise(JsonLineParser.Parse(line), _lineNumber);
            }
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            if (_ownsReader)
            {
                _reader.Dispose();
            }
        }

        private static NdjsonEntry Materialise(JsonRecord json, long lineNumber)
        {
            NdjsonEntry entry = new NdjsonEntry();
            entry.LineNumber = lineNumber;
            entry.Type = json.GetString(NdjsonFields.Type);

            switch (entry.Type)
            {
                case NdjsonRecordType.Meta:
                    MetaRecord meta = new MetaRecord();
                    meta.Key = json.GetString(NdjsonFields.MetaKey);
                    meta.Value = json.GetString(NdjsonFields.MetaValue);
                    entry.Meta = meta;
                    break;

                case NdjsonRecordType.Model:
                    SourceModelRecord model = new SourceModelRecord();
                    model.Id = json.GetInt64(NdjsonFields.Id, 0);
                    model.ParentId = json.GetNullableInt64(NdjsonFields.ParentId);
                    model.FileName = json.GetString(NdjsonFields.FileName);
                    model.DisplayName = json.GetString(NdjsonFields.Name);
                    model.Guid = json.GetString(NdjsonFields.Guid);
                    model.SourceFileName = json.GetString(NdjsonFields.SourceFileName);
                    model.SourceGuid = json.GetString(NdjsonFields.SourceGuid);
                    entry.SourceModel = model;
                    break;

                case NdjsonRecordType.Reference:
                    SourceReferenceRecord reference = new SourceReferenceRecord();
                    reference.SourceFileName = json.GetString(NdjsonFields.SourceFileName);

                    // Absent means loaded: only a plugin that looked and found
                    // nothing writes false, so a stream from an adapter that
                    // predates this record must not read as everything missing.
                    reference.Loaded = json.GetBoolean(NdjsonFields.Loaded, true);
                    entry.SourceReference = reference;
                    break;

                case NdjsonRecordType.Object:
                    ObjectRecord item = new ObjectRecord();
                    item.Id = json.GetInt64(NdjsonFields.Id, 0);
                    item.SourceModelId = json.GetNullableInt64(NdjsonFields.ModelId);
                    item.ParentId = json.GetNullableInt64(NdjsonFields.ParentId);
                    item.PathIndex = json.GetInt32(NdjsonFields.PathIndex, 0);
                    item.Depth = json.GetInt32(NdjsonFields.Depth, 0);
                    item.DisplayName = json.GetString(NdjsonFields.Name);
                    item.ClassName = json.GetString(NdjsonFields.ClassName);
                    item.InstanceGuid = json.GetString(NdjsonFields.InstanceGuid);
                    item.AuthoringId = json.GetString(NdjsonFields.AuthoringId);
                    item.AuthoringIdKind = json.GetString(NdjsonFields.AuthoringIdKind);
                    item.StructuralKey = json.GetString(NdjsonFields.StructuralKey);
                    item.Flags = json.GetInt64(NdjsonFields.Flags, 0);
                    item.BoundingBox = ReadBoundingBox(json);
                    entry.Object = item;
                    break;

                case NdjsonRecordType.Property:
                    PropertyRecord property = new PropertyRecord();
                    property.ObjectId = json.GetInt64(NdjsonFields.ObjectId, 0);
                    property.Category = json.GetString(NdjsonFields.Category);
                    property.CategoryInternal = json.GetString(NdjsonFields.CategoryInternal);
                    property.Name = json.GetString(NdjsonFields.Name);
                    property.NameInternal = json.GetString(NdjsonFields.NameInternal);
                    property.ValueText = json.GetString(NdjsonFields.Value);
                    property.ValueType = json.GetString(NdjsonFields.ValueType);
                    entry.Property = property;
                    break;

                case NdjsonRecordType.SelectionSet:
                    SelectionSetRecord set = new SelectionSetRecord();
                    set.Id = json.GetInt64(NdjsonFields.Id, 0);
                    set.ParentId = json.GetNullableInt64(NdjsonFields.ParentId);
                    set.Name = json.GetString(NdjsonFields.Name);
                    set.Kind = json.GetString(NdjsonFields.Kind);

                    // Absent means resolved: a stream from an adapter that
                    // predates schema v2 only ever recorded sets it had
                    // membership for, plus searches it declared unresolved in
                    // words. Defaulting the other way would mark every set in
                    // such a stream unusable.
                    set.MembershipResolved = json.GetBoolean(NdjsonFields.MembershipResolved, true);
                    set.Guid = json.GetString(NdjsonFields.Guid);
                    entry.SelectionSet = set;
                    break;

                case NdjsonRecordType.SelectionSetMember:
                    SelectionSetMemberRecord member = new SelectionSetMemberRecord();
                    member.SetId = json.GetInt64(NdjsonFields.SetId, 0);
                    member.ObjectId = json.GetInt64(NdjsonFields.ObjectId, 0);
                    entry.SelectionSetMember = member;
                    break;

                case NdjsonRecordType.Warning:
                    WarningRecord warning = new WarningRecord();
                    warning.Severity = json.GetString(NdjsonFields.Severity);
                    warning.Code = json.GetString(NdjsonFields.Code);
                    warning.Message = json.GetString(NdjsonFields.Message);
                    warning.ObjectId = json.GetNullableInt64(NdjsonFields.ObjectId);
                    entry.Warning = warning;
                    break;

                case NdjsonRecordType.Progress:
                    ProgressRecord progress = new ProgressRecord();
                    progress.Stage = json.GetString(NdjsonFields.Stage);
                    progress.Done = json.GetInt64(NdjsonFields.Done, 0);
                    progress.Total = json.GetInt64(NdjsonFields.Total, 0);
                    entry.Progress = progress;
                    break;

                case NdjsonRecordType.End:
                    EndRecord end = new EndRecord();
                    end.Ok = json.GetBoolean(NdjsonFields.Ok, false);
                    end.Code = json.GetString(NdjsonFields.Code);
                    end.Message = json.GetString(NdjsonFields.Message);
                    end.ObjectCount = json.GetInt64(NdjsonFields.ObjectCount, 0);
                    end.WarningCount = json.GetInt64(NdjsonFields.WarningCount, 0);
                    entry.End = end;
                    break;

                default:
                    // Unknown record type: skipped by the consumer. Deliberately
                    // not an error, so an older launcher survives a newer adapter.
                    break;
            }

            return entry;
        }

        private static double[] ReadBoundingBox(JsonRecord json)
        {
            double[] values = json.GetDoubleArray(NdjsonFields.BoundingBox);
            if (values == null || values.Length != 6)
            {
                return null;
            }

            for (int i = 0; i < values.Length; i++)
            {
                if (double.IsNaN(values[i]) || double.IsInfinity(values[i]))
                {
                    // All-or-none per row (schemas/extraction-cache.sql).
                    return null;
                }
            }

            return values;
        }
    }
}
