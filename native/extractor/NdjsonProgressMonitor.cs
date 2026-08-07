using System;
using System.IO;
using System.Threading;
using Matchline.Extraction.Protocol;

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
    /// </summary>
    internal sealed class NdjsonProgressMonitor : IDisposable
    {
        private const int PollIntervalMs = 1000;
        private const int BufferBytes = 1 << 16;

        private readonly string _path;
        private readonly ProgressReporter _reporter;
        private readonly ManualResetEvent _stop = new ManualResetEvent(false);
        private readonly Thread _thread;

        private long _offset;
        private long _lines;
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
                            if (buffer[i] == (byte)'\n')
                            {
                                _lines++;
                            }
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
    }
}
