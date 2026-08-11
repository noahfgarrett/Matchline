using System;
using System.Text;
using Matchline.Extraction.Json;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Ndjson
{
    /// <summary>
    /// Recognising a progress line in a stream that is still being written.
    /// <para>
    /// The launcher tails the plugin's NDJSON file to report progress and cannot
    /// afford to parse every line of a multi-gigabyte stream, so it sniffs for a
    /// byte prefix and only parses what matches. Both halves of that trick live
    /// here, next to <see cref="NdjsonWriter.WriteProgress(ProgressRecord)"/>,
    /// because a prefix that does not match what the writer emits is a silent
    /// failure: progress would simply never appear.
    /// </para>
    /// <para>
    /// It is also why this type exists at all rather than the monitor reading
    /// <c>NdjsonFields</c> directly -- the wire field names stay internal to this
    /// assembly, and the launcher asks a question instead of knowing an answer.
    /// </para>
    /// </summary>
    public static class NdjsonProgressLine
    {
        /// <summary>
        /// The bytes every progress line starts with, given that JsonLineBuilder
        /// writes fields in the order they are added and WriteProgress adds the
        /// record type first.
        /// <para>
        /// A fresh array each call: a shared static byte[] is mutable state
        /// wearing a readonly hat, and this is called once per monitor.
        /// </para>
        /// </summary>
        public static byte[] PrefixBytes()
        {
            return Encoding.UTF8.GetBytes(
                "{\"" + NdjsonFields.Type + "\":\"" + NdjsonRecordType.Progress + "\"");
        }

        /// <summary>
        /// Parses one line as a progress record, or answers false.
        /// <para>
        /// False covers every way a line can fail to be one: not JSON at all
        /// (half a line, most likely, from a buffer flushed mid-record), the
        /// wrong record type, or no stage name. The channel is advisory -- the
        /// run's verdict comes from the terminator record -- so nothing here
        /// throws.
        /// </para>
        /// </summary>
        public static bool TryParse(string line, out ProgressRecord record)
        {
            record = null;
            if (string.IsNullOrEmpty(line))
            {
                return false;
            }

            JsonRecord json;
            try
            {
                json = JsonLineParser.Parse(line);
            }
            catch (JsonParseException)
            {
                return false;
            }

            if (!string.Equals(
                    json.GetString(NdjsonFields.Type), NdjsonRecordType.Progress, StringComparison.Ordinal))
            {
                return false;
            }

            string stage = json.GetString(NdjsonFields.Stage);
            if (string.IsNullOrEmpty(stage))
            {
                return false;
            }

            ProgressRecord parsed = new ProgressRecord();
            parsed.Stage = stage;
            parsed.Done = json.GetInt64(NdjsonFields.Done, 0);
            parsed.Total = json.GetInt64(NdjsonFields.Total, 0);
            record = parsed;
            return true;
        }
    }
}
