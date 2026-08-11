using System;
using System.Collections.Generic;
using Matchline.Extraction.Records;

namespace Matchline.Extraction.Ndjson
{
    /// <summary>
    /// The warning policy every version adapter shares: a per-item or
    /// per-property read failure becomes a warning record and the walk continues
    /// (docs/EXTRACTION.md). Only a failure that makes the whole walk meaningless
    /// propagates out.
    /// <para>
    /// Two rules live here rather than in the walkers, because both are easy to
    /// get subtly wrong and neither is Autodesk-specific:
    /// </para>
    /// <para>
    /// (1) The count is incremented on emit, not on creation, so the number in
    /// the <c>end</c> record always equals the number of <c>warn</c> lines in the
    /// stream.
    /// </para>
    /// <para>
    /// (2) A warning that names an object id must not be written before that
    /// object's row exists -- otherwise the stream cannot be replayed into a
    /// cache with foreign-key enforcement on. Warnings raised while building an
    /// object are <see cref="Defer"/>red and released by
    /// <see cref="FlushDeferred"/> straight after the object record is written.
    /// </para>
    /// <para>
    /// Not thread-safe: one collector per walk, on the walking thread.
    /// </para>
    /// </summary>
    public sealed class WarningCollector
    {
        private readonly NdjsonWriter _writer;
        private List<WarningRecord> _deferred;
        private long _count;

        public WarningCollector(NdjsonWriter writer)
        {
            if (writer == null)
            {
                throw new ArgumentNullException("writer");
            }

            _writer = writer;
        }

        /// <summary>Warning lines written so far. Goes into the <c>end</c> record.</summary>
        public long Count
        {
            get { return _count; }
        }

        /// <summary>Writes a warning immediately.</summary>
        public void Warn(string severity, string code, string message, long? objectId)
        {
            Emit(Build(severity, code, message, objectId));
        }

        /// <summary>Writes a warning describing an exception.</summary>
        public void WarnException(string severity, string code, Exception exception, long? objectId)
        {
            Warn(severity, code, FailureText(exception), objectId);
        }

        /// <summary>
        /// Queues a warning that must not be written until the object row it
        /// references exists. Release it with <see cref="FlushDeferred"/>.
        /// </summary>
        public void Defer(string severity, string code, string message, long? objectId)
        {
            if (_deferred == null)
            {
                _deferred = new List<WarningRecord>();
            }

            _deferred.Add(Build(severity, code, message, objectId));
        }

        /// <summary>Queues a warning describing an exception.</summary>
        public void DeferException(string severity, string code, Exception exception, long? objectId)
        {
            Defer(severity, code, FailureText(exception), objectId);
        }

        /// <summary>Writes every deferred warning, in the order they were raised.</summary>
        public void FlushDeferred()
        {
            if (_deferred == null)
            {
                return;
            }

            for (int i = 0; i < _deferred.Count; i++)
            {
                Emit(_deferred[i]);
            }

            _deferred.Clear();
        }

        private static string FailureText(Exception exception)
        {
            return Protocol.FailureClassifier.Describe(exception);
        }

        private static WarningRecord Build(string severity, string code, string message, long? objectId)
        {
            WarningRecord record = new WarningRecord();
            record.Severity = severity;
            record.Code = code;
            record.Message = message ?? string.Empty;
            record.ObjectId = objectId;
            return record;
        }

        private void Emit(WarningRecord record)
        {
            _count++;
            _writer.WriteWarning(record);
        }
    }
}
