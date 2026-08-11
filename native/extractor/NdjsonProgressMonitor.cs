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

        private readonly string _path;
        private readonly ProgressReporter _reporter;
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private readonly Thread _thread;
        private readonly List<byte> _candidate = new List<byte>(MaxCandidateBytes);

        private long _offset;
        private long _lines;

        /// <summary>Bytes seen on the current line, whether or not they were kept.</summary>
        private int _lineBytes;

        /// <summary>False once the current line has ruled itself out.</summary>
        private bool _candidateAlive = true;

        private bool _disposed;

        internal NdjsonProgressMonitor(string path, ProgressReporter reporter)
        {
            _path = path;
            _reporter = reporter;
            _thread = new Thread(Loop);
            _thread.IsBackground = true;
            _thread.Name = "matchline-walk-progress";
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
        /// One byte of the stream: counts lines, and keeps the bytes of a line
        /// that still looks like a progress record.
        /// </summary>
        private void Consume(byte value)
        {
            if (value == (byte)'\n')
            {
                _lines++;
                if (_candidateAlive && _candidate.Count >= _progressPrefix.Length)
                {
                    RelayProgress(_candidate.ToArray());
                }

                _candidate.Clear();
                _lineBytes = 0;
                _candidateAlive = true;
                return;
            }

            if (!_candidateAlive)
            {
                return;
            }

            // A byte that disagrees with the prefix ends this line's candidacy;
            // so does a line long enough that it cannot be a progress record.
            if (_lineBytes < _progressPrefix.Length && value != _progressPrefix[_lineBytes])
            {
                _candidateAlive = false;
                _candidate.Clear();
                _lineBytes++;
                return;
            }

            if (_lineBytes >= MaxCandidateBytes)
            {
                _candidateAlive = false;
                _candidate.Clear();
                _lineBytes++;
                return;
            }

            _candidate.Add(value);
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

            _reporter.Progress(record.Stage, record.Done, record.Total);
        }
    }
}
