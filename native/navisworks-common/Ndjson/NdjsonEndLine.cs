using System.Text;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Ndjson
{
    /// <summary>
    /// Recognising the terminator record in a stream that is still being
    /// written.
    /// <para>
    /// The launcher tails the plugin's NDJSON file, and the one thing it most
    /// needs to know is whether the walk finished: once the <c>end</c> record
    /// has been written the stream is complete and whatever Roamer does next is
    /// irrelevant, so the launcher can stop waiting on a process that may never
    /// exit (docs/EXTRACTION.md; the audit's B6). Only the prefix is matched --
    /// the record's *contents* are read properly later, by the converter, from
    /// the finished file.
    /// </para>
    /// <para>
    /// It lives here for the same reason <see cref="NdjsonProgressLine"/> does:
    /// a prefix that does not match what <see cref="NdjsonWriter.WriteEnd"/>
    /// emits is a silent failure -- the launcher would simply never notice the
    /// end of a run -- so the question is asked of the writer's own assembly
    /// rather than answered by a literal in the launcher.
    /// </para>
    /// </summary>
    public static class NdjsonEndLine
    {
        /// <summary>
        /// The bytes every terminator line starts with, given that
        /// JsonLineBuilder writes fields in the order they are added and
        /// WriteEnd adds the record type first.
        /// <para>
        /// A fresh array each call, for the same reason as the progress prefix:
        /// a shared static byte[] is mutable state wearing a readonly hat.
        /// </para>
        /// </summary>
        public static byte[] PrefixBytes()
        {
            return Encoding.UTF8.GetBytes(
                "{\"" + NdjsonFields.Type + "\":\"" + NdjsonRecordType.End + "\"");
        }
    }
}
