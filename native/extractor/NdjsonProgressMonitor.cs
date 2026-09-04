using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using Matchline.Extraction.Ndjson;
using Matchline.Extraction.Protocol;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Extractor
{
    /// <summary>
    /// Reports walk progress while the plugin is still running.
    /// <para>
    /// The plugin writes NDJSON to a file inside the Navisworks process and has
    /// no channel back to the launcher, so progress is inferred by tailing that
    /// file and counting newlines. Reads are incremental (each poll continues
    /// from the previous offset) and never seek backwards, so the cost is one
    /// extra pass over bytes already in the OS cache.
    /// </para>
    /// <para>
    /// The count lags the real record count by whatever is sitting in the
    /// plugin's 64 KB write buffer. That is fine for a progress indicator and is
    /// never used for integrity.
    /// </para>
    /// <para>
    /// Counting newlines answers "is it still moving", which is enough for the
    /// tree walk and not enough for saved-set resolution: resolving one search
    /// set can take minutes and writes nothing until it finishes, so the line
    /// count sits still and the run looks hung. For that the plugin writes a
    /// <c>prog</c> record of its own, and this monitor relays it verbatim. Only
    /// lines that begin with that record's exact prefix are ever assembled and
    /// parsed; everything else is counted and discarded byte by byte, so
    /// tailing a multi-gigabyte stream costs no more than it did.
    /// </para>
    /// <para>
    /// The same byte-by-byte sniff answers the other question the launcher has
    /// no other way to ask: has the plugin finished? The terminator record's
    /// prefix is watched alongside the progress one, and once a complete
    /// <c>end</c> line has gone past, <see cref="EndRecordSeen"/> is true and
    /// the stream is known to be complete whatever Roamer does next. Two
    /// counters -- <see cref="BytesSeen"/> and <see cref="ProgressLinesSeen"/>
    /// -- are published for the same caller, which is what lets it tell a slow
    /// run from a stalled one.
    /// </para>
    /// </summary>
    internal sealed class NdjsonProgressMonitor : IDisposable
    {
        private const int PollIntervalMs = 1000;
        private const int BufferBytes = 1 << 16;

        /// <summary>
        /// Cap on a candidate line held in memory. A progress record is under a
        /// hundred bytes; anything longer is not one, whatever it starts with.
        /// </summary>
        private const int MaxCandidateBytes = 512;

        /// <summary>What a progress line starts with, asked of the writer's own assembly.</summary>
        private readonly byte[] _progressPrefix = NdjsonProgressLine.PrefixBytes();

        /// <summary>What the terminator line starts with, asked the same way.</summary>
        private readonly byte[] _endPrefix = NdjsonEndLine.PrefixBytes();

        private readonly string _path;
        private readonly ProgressReporter _reporter;
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private readonly Thread _thread;
        private readonly List<byte> _candidate = new List<byte>(MaxCandidateBytes);

        private long _offset;
        private long _lines;

        /// <summary>
        /// <see cref="_offset"/>, republished for the runner thread.
        /// <para>
        /// Its own field, written and read through Interlocked, because a long
        /// is not read atomically on every architecture and the reader is
        /// another thread entirely. A torn value here would show up as a stall
        /// that never happened.
        /// </para>
        /// </summary>
        private long _publishedOffset;

        /// <summary>Progress records relayed. Volatile: written here, read by the runner.</summary>
        private volatile int _progressLines;

        /// <summary>Set once a complete terminator line has gone past.</summary>
        private volatile bool _endSeen;

        /// <summary>Bytes seen on the current line, whether or not they were kept.</summary>
        private int _lineBytes;

        /// <summary>False once the current line has ruled itself out as a progress record.</summary>
        private bool _progressAlive = true;

        /// <summary>False once the current line has ruled itself out as the terminator.</summary>
        private bool _endAlive = true;

        private bool _disposed;

        internal NdjsonProgressMonitor(string path, ProgressReporter reporter)
        {
            _path = path;
            _reporter = reporter;
            _thread = new Thread(Loop);
            _thread.IsBackground = true;
            _thread.Name = "matchline-walk-progress";
        }

        /// <summary>
        /// True once the plugin has written its terminator record.
        /// <para>
        /// The launcher stops waiting on Roamer when this turns true: the
        /// stream is complete, so the exit code of a GUI executable that may
        /// never exit has nothing left to tell anyone (docs/EXTRACTION.md).
        /// </para>
        /// </summary>
        internal bool EndRecordSeen
        {
            get { return _endSeen; }
        }

        /// <summary>Bytes of the stream consumed so far. Safe to read from another thread.</summary>
        internal long BytesSeen
        {
            get { return Interlocked.Read(ref _publishedOffset); }
        }

        /// <summary>Progress records relayed so far. Safe to read from another thread.</summary>
        internal int ProgressLinesSeen
        {
            get { return _progressLines; }
        }

        internal void Start()
        {
            _thread.Start();
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _stop.Set();

            if (_thread.IsAlive)
            {
                _thread.Join(TimeSpan.FromSeconds(5));
            }

            _stop.Dispose();
        }

        private void Loop()
        {
            try
            {
                while (!_stop.WaitOne(PollIntervalMs))
                {
                    CountNewLines();

                    // total is 0 = unknown: the record count is not knowable
                    // until the plugin finishes.
                    _reporter.Progress(ExtractionStages.Walk, _lines, 0);
                }
            }
            catch (ObjectDisposedException)
            {
                // Dispose() raced this loop. Progress reporting is advisory; an
                // unhandled exception on a background thread would take the
                // whole process down, which is not a trade worth making.
            }
        }

        private void CountNewLines()
        {
            try
            {
                using (FileStream stream = new FileStream(
                    _path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete,
                    BufferBytes, FileOptions.SequentialScan))
                {
                    if (stream.Length <= _offset)
                    {
                        return;
                    }

                    stream.Position = _offset;
                    byte[] buffer = new byte[BufferBytes];

                    while (true)
                    {
                        int read = stream.Read(buffer, 0, buffer.Length);
                        if (read <= 0)
                        {
                            break;
                        }

                        for (int i = 0; i < read; i++)
                        {
                            Consume(buffer[i]);
                        }

                        _offset += read;
                        Interlocked.Exchange(ref _publishedOffset, _offset);
                    }
                }
            }
            catch (FileNotFoundException)
            {
                // The plugin has not created the stream yet.
            }
            catch (IOException)
            {
                // Transient sharing conflict; the next poll picks up where this
                // one left off.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        /// <summary>
        /// One byte of the stream: counts lines, keeps the bytes of a line that
        /// still looks like a progress record, and notices the terminator.
        /// </summary>
        private void Consume(byte value)
        {
            if (value == (byte)'\n')
            {
                _lines++;
                if (_progressAlive && _lineBytes >= _progressPrefix.Length)
                {
                    RelayProgress(_candidate.ToArray());
                }

                // Only a line that is complete counts as the terminator: half a
                // record is what a plugin killed mid-write leaves behind, and
                // treating that as "finished" is the one mistake this sniff
                // must never make.
                if (_endAlive && _lineBytes >= _endPrefix.Length)
                {
                    _endSeen = true;
                }

                _candidate.Clear();
                _lineBytes = 0;
                _progressAlive = true;
                _endAlive = true;
                return;
            }

            if (_progressAlive)
            {
                // A byte that disagrees with the prefix ends this line's
                // candidacy; so does a line long enough that it cannot be a
                // progress record.
                if (_lineBytes < _progressPrefix.Length && value != _progressPrefix[_lineBytes])
                {
                    _progressAlive = false;
                    _candidate.Clear();
                }
                else if (_lineBytes >= MaxCandidateBytes)
                {
                    _progressAlive = false;
                    _candidate.Clear();
                }
                else
                {
                    _candidate.Add(value);
                }
            }

            if (_endAlive && _lineBytes < _endPrefix.Length && value != _endPrefix[_lineBytes])
            {
                _endAlive = false;
            }

            // Counted for every byte of the line, candidate or not: the two
            // prefixes are matched against this position, and a counter that
            // stopped when one of them gave up would misalign the other.
            _lineBytes++;
        }

        /// <summary>
        /// Forwards one plugin-side progress record to the launcher's own stdout.
        /// <para>
        /// A line that will not parse is dropped in silence on purpose: this
        /// channel is advisory, and the run's real verdict comes from the
        /// terminator record the converter reads afterwards. A record split
        /// across two polls is not such a case -- the candidate buffer survives
        /// between polls, so the line is relayed when its newline arrives.
        /// </para>
        /// </summary>
        private void RelayProgress(byte[] line)
        {
            string text;
            try
            {
                text = Encoding.UTF8.GetString(line);
            }
            catch (ArgumentException)
            {
                return;
            }

            ProgressRecord record;
            if (!NdjsonProgressLine.TryParse(text, out record))
            {
                return;
            }

            _progressLines++;
            _reporter.Progress(record.Stage, record.Done, record.Total);
        }
    }
}
