using System;
using System.Globalization;
using System.IO;
using Matchline.Extraction.Protocol;
using Microsoft.Data.Sqlite;

namespace Matchline.Extraction.Extractor
{
    /// <summary>Result of inspecting an existing cache file.</summary>
    internal sealed class CacheValidation
    {
        internal bool IsValid { get; set; }

        internal long ObjectCount { get; set; }

        internal long WarningCount { get; set; }

        /// <summary>Why the cache was rejected; null when valid.</summary>
        internal string Reason { get; set; }
    }

    /// <summary>
    /// Read-only validation of an existing cache, used for the cache-hit check.
    /// <para>
    /// A cache is only trusted when the schema version is one this build knows
    /// and <c>meta.object_count</c> still equals <c>COUNT(*)</c> of objects. That
    /// is the same integrity check the writer runs before committing, so a
    /// truncated or hand-edited file is never reused.
    /// </para>
    /// </summary>
    internal static class CacheInspector
    {
        internal static CacheValidation Validate(string cachePath)
        {
            CacheValidation validation = new CacheValidation();

            if (!File.Exists(cachePath))
            {
                validation.Reason = "cache file does not exist";
                return validation;
            }

            try
            {
                SqliteConnectionStringBuilder builder = new SqliteConnectionStringBuilder();
                builder.DataSource = cachePath;
                builder.Mode = SqliteOpenMode.ReadOnly;
                builder.Pooling = false;

                using (SqliteConnection connection = new SqliteConnection(builder.ToString()))
                {
                    connection.Open();

                    string schemaVersion = ReadMeta(connection, CacheMetaKeys.SchemaVersion);
                    if (schemaVersion != CacheMetaKeys.CurrentSchemaVersion)
                    {
                        validation.Reason = "schema_version is '" + (schemaVersion ?? "<missing>") +
                            "', this build writes '" + CacheMetaKeys.CurrentSchemaVersion + "'";
                        return validation;
                    }

                    string declared = ReadMeta(connection, CacheMetaKeys.ObjectCount);
                    long declaredCount;
                    if (declared == null ||
                        !long.TryParse(declared, NumberStyles.None, CultureInfo.InvariantCulture, out declaredCount))
                    {
                        validation.Reason = "meta.object_count is missing or not a number";
                        return validation;
                    }

                    long actualCount = ScalarLong(connection, "SELECT COUNT(*) FROM objects");
                    if (actualCount != declaredCount)
                    {
                        validation.Reason = "meta.object_count (" +
                            declaredCount.ToString(CultureInfo.InvariantCulture) +
                            ") does not match COUNT(*) of objects (" +
                            actualCount.ToString(CultureInfo.InvariantCulture) + ")";
                        return validation;
                    }

                    validation.ObjectCount = actualCount;
                    validation.WarningCount = ScalarLong(connection, "SELECT COUNT(*) FROM warnings");
                    validation.IsValid = true;
                    return validation;
                }
            }
            catch (SqliteException ex)
            {
                validation.Reason = "cache could not be read: " + ex.Message;
                return validation;
            }
            catch (IOException ex)
            {
                validation.Reason = "cache could not be read: " + ex.Message;
                return validation;
            }
            catch (InvalidOperationException ex)
            {
                validation.Reason = "cache could not be read: " + ex.Message;
                return validation;
            }
        }

        private static string ReadMeta(SqliteConnection connection, string key)
        {
            using (SqliteCommand command = connection.CreateCommand())
            {
                command.CommandText = "SELECT value FROM meta WHERE key = $key";
                command.Parameters.Add("$key", SqliteType.Text).Value = key;
                object value = command.ExecuteScalar();
                if (value == null || value == DBNull.Value)
                {
                    return null;
                }

                return value.ToString();
            }
        }

        private static long ScalarLong(SqliteConnection connection, string sql)
        {
            using (SqliteCommand command = connection.CreateCommand())
            {
                command.CommandText = sql;
                object value = command.ExecuteScalar();
                if (value == null || value == DBNull.Value)
                {
                    return 0;
                }

                return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            }
        }
    }
}
