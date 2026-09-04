using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Matchline.Extraction.Protocol;
using Matchline.Extraction.Records;
using Microsoft.Data.Sqlite;

namespace Matchline.Extraction.Extractor
{
    /// <summary>Thrown when the written cache fails its own integrity checks.</summary>
    internal sealed class CacheIntegrityException : Exception
    {
        internal CacheIntegrityException(string message)
            : base(message)
        {
        }
    }

    /// <summary>
    /// Writes one SQLite cache file, per schemas/extraction-cache.sql.
    /// <para>
    /// This is the only place in the codebase that opens a SQLite connection
    /// during extraction, and it lives in the launcher process on purpose: the
    /// Navisworks plugin must never load native SQLite (EXTRACTION.md).
    /// </para>
    /// <para>
    /// The caller always points this at a <c>.partial</c> path; the real cache
    /// filename only ever appears via <see cref="Commit"/>'s rename, after the
    /// integrity checks pass.
    /// </para>
    /// </summary>
    internal sealed class CacheWriter : IDisposable
    {
        /// <summary>Rows per transaction. Large enough to be fast, small enough to bound memory.</summary>
        private const int RowsPerTransaction = 100000;

        private readonly SqliteConnection _connection;
        private readonly List<SqliteCommand> _commands = new List<SqliteCommand>();

        private SqliteTransaction _transaction;
        private long _pendingRows;
        private bool _disposed;

        private SqliteCommand _insertMeta;
        private SqliteCommand _insertModel;
        private SqliteCommand _insertObject;
        private SqliteCommand _insertProperty;
        private SqliteCommand _insertSet;
        private SqliteCommand _insertMember;
        private SqliteCommand _insertWarning;

        private CacheWriter(string partialPath)
        {
            // Pooling=False matters: with pooling on, the file handle can outlive
            // Dispose() and make the atomic rename fail on Windows.
            SqliteConnectionStringBuilder builder = new SqliteConnectionStringBuilder();
            builder.DataSource = partialPath;
            builder.Mode = SqliteOpenMode.ReadWriteCreate;
            builder.Pooling = false;

            _connection = new SqliteConnection(builder.ToString());
            _connection.Open();
        }

        /// <summary>Creates a fresh cache file at <paramref name="partialPath"/>.</summary>
        internal static CacheWriter Create(string partialPath)
        {
            if (File.Exists(partialPath))
            {
                File.Delete(partialPath);
            }

            CacheWriter writer = new CacheWriter(partialPath);
            try
            {
                writer.Initialise();
                return writer;
            }
            catch
            {
                writer.Dispose();
                throw;
            }
        }

        internal void WriteSourceModel(SourceModelRecord record)
        {
            SetInt(_insertModel, "$id", record.Id);
            SetNullableInt(_insertModel, "$parent_id", record.ParentId);
            SetText(_insertModel, "$file_name", record.FileName);
            SetText(_insertModel, "$display_name", record.DisplayName);
            SetText(_insertModel, "$guid", record.Guid);
            SetText(_insertModel, "$source_file_name", record.SourceFileName);
            SetText(_insertModel, "$source_guid", record.SourceGuid);
            Execute(_insertModel);
        }

        internal void WriteObject(ObjectRecord record)
        {
            SetInt(_insertObject, "$id", record.Id);
            SetNullableInt(_insertObject, "$source_model_id", record.SourceModelId);
            SetNullableInt(_insertObject, "$parent_id", record.ParentId);
            SetInt(_insertObject, "$path_index", record.PathIndex);
            SetInt(_insertObject, "$depth", record.Depth);
            SetText(_insertObject, "$display_name", record.DisplayName);
            SetText(_insertObject, "$class_name", record.ClassName);
            SetText(_insertObject, "$instance_guid", record.InstanceGuid);
            SetText(_insertObject, "$authoring_id", record.AuthoringId);
            SetText(_insertObject, "$authoring_id_kind", record.AuthoringIdKind);
            SetText(_insertObject, "$structural_key", record.StructuralKey);

            // NOT NULL in the DDL: an object whose flags could not be read is
            // recorded as flagged with nothing, which is what the walker sends.
            SetInt(_insertObject, "$flags", record.Flags);

            double[] box = record.BoundingBox;
            string[] names =
            {
                "$bbox_min_x", "$bbox_min_y", "$bbox_min_z",
                "$bbox_max_x", "$bbox_max_y", "$bbox_max_z"
            };

            for (int i = 0; i < names.Length; i++)
            {
                // All-or-none per row: a partial box is stored as no box.
                object value = box == null ? (object)DBNull.Value : box[i];
                _insertObject.Parameters[names[i]].Value = value;
            }

            Execute(_insertObject);
        }

        internal void WriteProperty(PropertyRecord record)
        {
            SetInt(_insertProperty, "$object_id", record.ObjectId);
            SetText(_insertProperty, "$category", record.Category ?? string.Empty);
            SetText(_insertProperty, "$category_internal", record.CategoryInternal);
            SetText(_insertProperty, "$name", record.Name ?? string.Empty);
            SetText(_insertProperty, "$name_internal", record.NameInternal);
            SetText(_insertProperty, "$value_text", record.ValueText);
            SetText(_insertProperty, "$value_type", record.ValueType ?? "None");
            Execute(_insertProperty);
        }

        internal void WriteSelectionSet(SelectionSetRecord record)
        {
            SetInt(_insertSet, "$id", record.Id);
            SetNullableInt(_insertSet, "$parent_id", record.ParentId);
            SetText(_insertSet, "$name", record.Name ?? string.Empty);
            SetText(_insertSet, "$kind", record.Kind ?? SelectionSetKind.Folder);

            // The column is INTEGER 0/1 rather than a bool: SQLite has no
            // boolean type and the DDL's CHECK is written against 0 and 1.
            SetInt(_insertSet, "$membership_resolved", record.MembershipResolved ? 1 : 0);
            SetText(_insertSet, "$guid", record.Guid);
            Execute(_insertSet);
        }

        internal void WriteSelectionSetMember(SelectionSetMemberRecord record)
        {
            SetInt(_insertMember, "$set_id", record.SetId);
            SetInt(_insertMember, "$object_id", record.ObjectId);
            Execute(_insertMember);
        }

        internal void WriteWarning(WarningRecord record)
        {
            SetText(_insertWarning, "$severity", record.Severity ?? WarningSeverity.Warning);
            SetText(_insertWarning, "$code", record.Code ?? "UNKNOWN");
            SetText(_insertWarning, "$message", record.Message ?? string.Empty);
            SetNullableInt(_insertWarning, "$object_id", record.ObjectId);
            Execute(_insertWarning);
        }

        internal void WriteMeta(string key, string value)
        {
            SetText(_insertMeta, "$key", key);
            SetText(_insertMeta, "$value", value ?? string.Empty);
            Execute(_insertMeta);
        }

        internal long CountObjects()
        {
            return ScalarLong("SELECT COUNT(*) FROM objects");
        }

        internal long CountWarnings()
        {
            return ScalarLong("SELECT COUNT(*) FROM warnings");
        }

        /// <summary>
        /// Flushes everything, verifies the cache against itself, closes the
        /// connection, fsyncs, and atomically renames the partial file into place.
        /// The real filename never exists in a half-written state.
        /// </summary>
        internal void Commit(
            string partialPath,
            string finalPath,
            IDictionary<string, string> meta,
            long expectedObjectCount)
        {
            foreach (KeyValuePair<string, string> pair in meta)
            {
                WriteMeta(pair.Key, pair.Value);
            }

            long actualObjects = CountObjects();
            if (actualObjects != expectedObjectCount)
            {
                throw new CacheIntegrityException(
                    "object count mismatch: the stream declared " +
                    expectedObjectCount.ToString(CultureInfo.InvariantCulture) +
                    " objects but the cache holds " +
                    actualObjects.ToString(CultureInfo.InvariantCulture) + ".");
            }

            // meta.object_count is the integrity check readers re-run, so it is
            // written from what is actually in the table, not from the stream.
            WriteMeta(CacheMetaKeys.ObjectCount, actualObjects.ToString(CultureInfo.InvariantCulture));

            CommitTransaction();
            VerifyRequiredMeta();

            Dispose();

            FlushToDisk(partialPath);

            if (File.Exists(finalPath))
            {
                // Content-addressed by SHA-256: an existing file is the same
                // input. A concurrent run beat us to it; keep theirs.
                File.Delete(partialPath);
                return;
            }

            File.Move(partialPath, finalPath);
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;

            if (_transaction != null)
            {
                try
                {
                    _transaction.Rollback();
                }
                catch (Exception)
                {
                    // Nothing to salvage: the partial file is discarded anyway.
                }

                _transaction.Dispose();
                _transaction = null;
            }

            for (int i = 0; i < _commands.Count; i++)
            {
                _commands[i].Dispose();
            }

            _commands.Clear();
            _connection.Dispose();
        }

        private void Initialise()
        {
            // journal_mode=OFF and synchronous=OFF are safe here precisely
            // because of the atomic-commit design: a torn partial file is thrown
            // away, never renamed. The single fsync before the rename is what
            // makes the committed cache durable.
            ExecuteScript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;");
            ExecuteScript(CacheSchema.Ddl);

            _insertMeta = PrepareInsert(
                "INSERT OR REPLACE INTO meta(key, value) VALUES($key, $value)",
                new string[] { "$key", "$value" },
                new SqliteType[] { SqliteType.Text, SqliteType.Text });

            _insertModel = PrepareInsert(
                "INSERT INTO source_models(id, parent_id, file_name, display_name, guid, " +
                "source_file_name, source_guid) " +
                "VALUES($id, $parent_id, $file_name, $display_name, $guid, " +
                "$source_file_name, $source_guid)",
                new string[]
                {
                    "$id", "$parent_id", "$file_name", "$display_name", "$guid",
                    "$source_file_name", "$source_guid"
                },
                new SqliteType[]
                {
                    SqliteType.Integer, SqliteType.Integer, SqliteType.Text, SqliteType.Text, SqliteType.Text,
                    SqliteType.Text, SqliteType.Text
                });

            _insertObject = PrepareInsert(
                "INSERT INTO objects(id, source_model_id, parent_id, path_index, depth, display_name, " +
                "class_name, instance_guid, authoring_id, authoring_id_kind, structural_key, flags, " +
                "bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z) " +
                "VALUES($id, $source_model_id, $parent_id, $path_index, $depth, $display_name, " +
                "$class_name, $instance_guid, $authoring_id, $authoring_id_kind, $structural_key, $flags, " +
                "$bbox_min_x, $bbox_min_y, $bbox_min_z, $bbox_max_x, $bbox_max_y, $bbox_max_z)",
                new string[]
                {
                    "$id", "$source_model_id", "$parent_id", "$path_index", "$depth", "$display_name",
                    "$class_name", "$instance_guid", "$authoring_id", "$authoring_id_kind",
                    "$structural_key", "$flags",
                    "$bbox_min_x", "$bbox_min_y", "$bbox_min_z", "$bbox_max_x", "$bbox_max_y", "$bbox_max_z"
                },
                new SqliteType[]
                {
                    SqliteType.Integer, SqliteType.Integer, SqliteType.Integer, SqliteType.Integer,
                    SqliteType.Integer, SqliteType.Text, SqliteType.Text, SqliteType.Text, SqliteType.Text,
                    SqliteType.Text, SqliteType.Text, SqliteType.Integer,
                    SqliteType.Real, SqliteType.Real, SqliteType.Real,
                    SqliteType.Real, SqliteType.Real, SqliteType.Real
                });

            _insertProperty = PrepareInsert(
                "INSERT INTO properties(object_id, category, category_internal, name, name_internal, " +
                "value_text, value_type) " +
                "VALUES($object_id, $category, $category_internal, $name, $name_internal, $value_text, $value_type)",
                new string[]
                {
                    "$object_id", "$category", "$category_internal", "$name", "$name_internal",
                    "$value_text", "$value_type"
                },
                new SqliteType[]
                {
                    SqliteType.Integer, SqliteType.Text, SqliteType.Text, SqliteType.Text,
                    SqliteType.Text, SqliteType.Text, SqliteType.Text
                });

            _insertSet = PrepareInsert(
                "INSERT INTO selection_sets(id, parent_id, name, kind, membership_resolved, guid) " +
                "VALUES($id, $parent_id, $name, $kind, $membership_resolved, $guid)",
                new string[] { "$id", "$parent_id", "$name", "$kind", "$membership_resolved", "$guid" },
                new SqliteType[]
                {
                    SqliteType.Integer, SqliteType.Integer, SqliteType.Text, SqliteType.Text,
                    SqliteType.Integer, SqliteType.Text
                });

            // OR IGNORE: (set_id, object_id) is the primary key and a set can
            // legitimately list the same item twice.
            _insertMember = PrepareInsert(
                "INSERT OR IGNORE INTO selection_set_members(set_id, object_id) VALUES($set_id, $object_id)",
                new string[] { "$set_id", "$object_id" },
                new SqliteType[] { SqliteType.Integer, SqliteType.Integer });

            _insertWarning = PrepareInsert(
                "INSERT INTO warnings(severity, code, message, object_id) " +
                "VALUES($severity, $code, $message, $object_id)",
                new string[] { "$severity", "$code", "$message", "$object_id" },
                new SqliteType[] { SqliteType.Text, SqliteType.Text, SqliteType.Text, SqliteType.Integer });

            BeginTransaction();
        }

        private SqliteCommand PrepareInsert(string sql, string[] parameterNames, SqliteType[] parameterTypes)
        {
            SqliteCommand command = _connection.CreateCommand();
            command.CommandText = sql;
            for (int i = 0; i < parameterNames.Length; i++)
            {
                command.Parameters.Add(parameterNames[i], parameterTypes[i]);
            }

            _commands.Add(command);
            return command;
        }

        private void BeginTransaction()
        {
            _transaction = _connection.BeginTransaction();
            for (int i = 0; i < _commands.Count; i++)
            {
                _commands[i].Transaction = _transaction;
            }

            _pendingRows = 0;
        }

        private void CommitTransaction()
        {
            if (_transaction == null)
            {
                return;
            }

            _transaction.Commit();
            _transaction.Dispose();
            _transaction = null;

            for (int i = 0; i < _commands.Count; i++)
            {
                _commands[i].Transaction = null;
            }
        }

        private void Execute(SqliteCommand command)
        {
            command.ExecuteNonQuery();
            _pendingRows++;
            if (_pendingRows >= RowsPerTransaction)
            {
                CommitTransaction();
                BeginTransaction();
            }
        }

        private void ExecuteScript(string sql)
        {
            using (SqliteCommand command = _connection.CreateCommand())
            {
                command.CommandText = sql;
                command.ExecuteNonQuery();
            }
        }

        private long ScalarLong(string sql)
        {
            using (SqliteCommand command = _connection.CreateCommand())
            {
                command.CommandText = sql;
                command.Transaction = _transaction;
                object value = command.ExecuteScalar();
                if (value == null || value == DBNull.Value)
                {
                    return 0;
                }

                return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            }
        }

        private void VerifyRequiredMeta()
        {
            string[] required = CacheMetaKeys.Required();
            List<string> missing = new List<string>();

            using (SqliteCommand command = _connection.CreateCommand())
            {
                command.CommandText = "SELECT value FROM meta WHERE key = $key";
                command.Parameters.Add("$key", SqliteType.Text);

                for (int i = 0; i < required.Length; i++)
                {
                    command.Parameters["$key"].Value = required[i];
                    object value = command.ExecuteScalar();
                    if (value == null || value == DBNull.Value || string.IsNullOrEmpty(value.ToString()))
                    {
                        missing.Add(required[i]);
                    }
                }
            }

            if (missing.Count > 0)
            {
                throw new CacheIntegrityException(
                    "required meta keys are missing or empty: " + string.Join(", ", missing.ToArray()) + ".");
            }
        }

        /// <summary>
        /// Forces the finished partial file out of the OS cache before the
        /// rename, so a power loss right after the rename cannot leave a
        /// valid-looking name over torn bytes.
        /// </summary>
        private static void FlushToDisk(string path)
        {
            using (FileStream stream = new FileStream(
                path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                stream.Flush(true);
            }
        }

        private static void SetInt(SqliteCommand command, string name, long value)
        {
            command.Parameters[name].Value = value;
        }

        private static void SetNullableInt(SqliteCommand command, string name, long? value)
        {
            command.Parameters[name].Value = value.HasValue ? (object)value.Value : DBNull.Value;
        }

        private static void SetText(SqliteCommand command, string name, string value)
        {
            command.Parameters[name].Value = value == null ? (object)DBNull.Value : value;
        }
    }
}
