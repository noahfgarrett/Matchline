using System;
using System.IO;
using Matchline.Extraction.Json;

namespace Matchline.Extraction.Protocol
{
    /// <summary>
    /// Emits the launcher's stdout protocol (EXTRACTION.md): one JSON object per
    /// line, flushed immediately so a parent process sees progress live.
    /// <para>
    /// Thread-safe: the stdin cancel listener and the walk-progress monitor both
    /// write through this while the main thread is working.
    /// </para>
    /// <para>
    /// A <c>total</c> of 0 means "unknown" -- the walk and convert stages have no
    /// cheap way to know the record count up front.
    /// </para>
    /// </summary>
    public sealed class ProgressReporter : IDisposable
    {
        private readonly object _gate = new object();
        private readonly JsonLineBuilder _builder = new JsonLineBuilder();
        private readonly TextWriter _writer;
        private readonly bool _ownsWriter;
        private bool _disposed;

        public ProgressReporter(TextWriter writer, bool ownsWriter)
        {
            if (writer == null)
            {
                throw new ArgumentNullException("writer");
            }

            _writer = writer;
            _writer.NewLine = "\n";
            _ownsWriter = ownsWriter;
        }

        public void Progress(string stage, long done, long total)
        {
            Progress(stage, done, total, null);
        }

        /// <summary>
        /// A progress line with a human-readable <c>detail</c> string. The field
        /// is omitted entirely when <paramref name="detail"/> is null, so the
        /// stages that have nothing to say emit exactly the line they always did.
        /// </summary>
        public void Progress(string stage, long done, long total, string detail)
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _builder.Begin()
                    .AddString("type", "progress")
                    .AddString("stage", stage)
                    .AddInt("done", done)
                    .AddInt("total", total);

                if (detail != null)
                {
                    _builder.AddString("detail", detail);
                }

                Emit();
            }
        }

        public void Warning(string code, string message, long? objectId)
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _builder.Begin()
                    .AddString("type", "warning")
                    .AddString("code", code)
                    .AddString("message", message)
                    .AddNullableInt("objectId", objectId);
                Emit();
            }
        }

        public void Result(string status, string cachePath, long objects, long warnings)
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _builder.Begin()
                    .AddString("type", "result")
                    .AddString("status", status)
                    .AddString("cachePath", cachePath)
                    .AddInt("objects", objects)
                    .AddInt("warnings", warnings);
                Emit();
            }
        }

        public void ResultOk(string cachePath, long objects, long warnings)
        {
            Result("ok", cachePath, objects, warnings);
        }

        public void ResultCacheHit(string cachePath, long objects, long warnings)
        {
            Result("cache-hit", cachePath, objects, warnings);
        }

        public void Error(string code, string message)
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _builder.Begin()
                    .AddString("type", "error")
                    .AddString("code", code)
                    .AddString("message", message);
                Emit();
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposed = true;
                try
                {
                    _writer.Flush();
                }
                catch (IOException)
                {
                    // A closed pipe on shutdown is not worth failing over.
                }

                if (_ownsWriter)
                {
                    _writer.Dispose();
                }
            }
        }

        private void Emit()
        {
            try
            {
                _writer.Write(_builder.End());
                _writer.Write('\n');
                _writer.Flush();
            }
            catch (IOException)
            {
                // Parent went away mid-run; keep extracting rather than crashing.
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }
}
