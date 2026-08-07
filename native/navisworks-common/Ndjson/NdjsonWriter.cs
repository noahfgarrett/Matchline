using System;
using System.IO;
using System.Text;
using Matchline.Extraction.Json;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Ndjson
{
    /// <summary>
    /// Writes the extraction hand-off stream: one JSON object per line, UTF-8,
    /// LF line endings, no BOM.
    /// <para>
    /// Used by the Navisworks version adapter. It never touches SQLite -- the
    /// launcher owns that (EXTRACTION.md, design call 1).
    /// </para>
    /// <para>Not thread-safe; the walk is single-threaded by design.</para>
    /// </summary>
    public sealed class NdjsonWriter : IDisposable
    {
        private const int BufferBytes = 1 << 16;

        private readonly JsonLineBuilder _builder = new JsonLineBuilder();
        private readonly TextWriter _writer;
        private readonly bool _ownsWriter;
        private bool _disposed;

        public NdjsonWriter(TextWriter writer, bool ownsWriter)
        {
            if (writer == null)
            {
                throw new ArgumentNullException("writer");
            }

            _writer = writer;
            _writer.NewLine = "\n";
            _ownsWriter = ownsWriter;
        }

        /// <summary>
        /// Creates (or truncates) the stream file.
        /// <para>
        /// The share mode matters: the launcher tails this file while the plugin
        /// is still writing it, to report walk progress. ReadWrite|Delete lets it
        /// read the partial contents and lets cleanup delete the file afterwards.
        /// </para>
        /// </summary>
        public static NdjsonWriter CreateFile(string path)
        {
            FileStream stream = new FileStream(
                path,
                FileMode.Create,
                FileAccess.Write,
                FileShare.ReadWrite | FileShare.Delete,
                BufferBytes,
                FileOptions.None);

            StreamWriter writer = null;
            try
            {
                writer = new StreamWriter(stream, new UTF8Encoding(false), BufferBytes);
                return new NdjsonWriter(writer, true);
            }
            catch
            {
                if (writer != null)
                {
                    writer.Dispose();
                }
                else
                {
                    stream.Dispose();
                }

                throw;
            }
        }

        public void WriteMeta(MetaRecord record)
        {
            _builder.Begin()
                .AddString(NdjsonFields.Type, NdjsonRecordType.Meta)
                .AddString(NdjsonFields.MetaKey, record.Key)
                .AddString(NdjsonFields.MetaValue, record.Value);
            WriteLine();
        }

        public void WriteMeta(string key, string value)
        {
            MetaRecord record = new MetaRecord();
            record.Key = key;
            record.Value = value;
            WriteMeta(record);
        }

        public void WriteSourceModel(SourceModelRecord record)
        {
            _builder.Begin()
                .AddString(NdjsonFields.Type, NdjsonRecordType.Model)
                .AddInt(NdjsonFields.Id, record.Id)
                .AddNullableInt(NdjsonFields.ParentId, record.ParentId)
                .AddString(NdjsonFields.FileName, record.FileName)
                .AddString(NdjsonFields.Name, record.DisplayName)
                .AddString(NdjsonFields.Guid, record.SourceGuid);
            WriteLine();
        }

        public void WriteObject(ObjectRecord record)
        {
            _builder.Begin()
                .AddString(NdjsonFields.Type, NdjsonRecordType.Object)
                .AddInt(NdjsonFields.Id, record.Id)
                .AddNullableInt(NdjsonFields.ModelId, record.SourceModelId)
                .AddNullableInt(NdjsonFields.ParentId, record.ParentId)
                .AddInt(NdjsonFields.PathIndex, record.PathIndex)
                .AddInt(NdjsonFields.Depth, record.Depth)
                .AddString(NdjsonFields.Name, record.DisplayName)
                .AddString(NdjsonFields.ClassName, record.ClassName)
                .AddString(NdjsonFields.InstanceGuid, record.InstanceGuid)
                .AddString(NdjsonFields.AuthoringId, record.AuthoringId)
                .AddDoubleArray(NdjsonFields.BoundingBox, record.BoundingBox);
            WriteLine();
        }

        public void WriteProperty(PropertyRecord record)
        {
            _builder.Begin()
                .AddString(NdjsonFields.Type, NdjsonRecordType.Property)
                .AddInt(NdjsonFields.ObjectId, record.ObjectId)
                .AddString(NdjsonFields.Category, record.Category)
                .AddString(NdjsonFields.CategoryInternal, record.CategoryInternal)
                .AddString(NdjsonFields.Name, record.Name)
                .AddString(NdjsonFields.NameInternal, record.NameInternal)
                .AddString(NdjsonFields.Value, record.ValueText)
                .AddString(NdjsonFields.ValueType, record.ValueType);
            WriteLine();
        }

        public void WriteSelectionSet(SelectionSetRecord record)
        {
            _builder.Begin()
                .AddString(NdjsonFields.Type, NdjsonRecordType.SelectionSet)
                .AddInt(NdjsonFields.Id, record.Id)
                .AddNullableInt(NdjsonFields.ParentId, record.ParentId)
                .AddString(NdjsonFields.Name, record.Name)
                .AddString(NdjsonFields.Kind, record.Kind);
            WriteLine();
        }

        public void WriteSelectionSetMember(SelectionSetMemberRecord record)
        {
            _builder.Begin()
                .AddString(NdjsonFields.Type, NdjsonRecordType.SelectionSetMember)
                .AddInt(NdjsonFields.SetId, record.SetId)
                .AddInt(NdjsonFields.ObjectId, record.ObjectId);
            WriteLine();
        }

        public void WriteWarning(WarningRecord record)
        {
            _builder.Begin()
                .AddString(NdjsonFields.Type, NdjsonRecordType.Warning)
                .AddString(NdjsonFields.Severity, record.Severity)
                .AddString(NdjsonFields.Code, record.Code)
                .AddString(NdjsonFields.Message, record.Message)
                .AddNullableInt(NdjsonFields.ObjectId, record.ObjectId);
            WriteLine();
        }

        public void WriteEnd(EndRecord record)
        {
            _builder.Begin()
                .AddString(NdjsonFields.Type, NdjsonRecordType.End)
                .AddBool(NdjsonFields.Ok, record.Ok)
                .AddString(NdjsonFields.Code, record.Code)
                .AddString(NdjsonFields.Message, record.Message)
                .AddInt(NdjsonFields.ObjectCount, record.ObjectCount)
                .AddInt(NdjsonFields.WarningCount, record.WarningCount);
            WriteLine();
            Flush();
        }

        public void Flush()
        {
            _writer.Flush();
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            if (_ownsWriter)
            {
                _writer.Dispose();
            }
            else
            {
                _writer.Flush();
            }
        }

        private void WriteLine()
        {
            _writer.Write(_builder.End());
            _writer.Write('\n');
        }
    }
}
