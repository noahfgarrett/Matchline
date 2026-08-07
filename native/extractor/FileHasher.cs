using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Matchline.Extraction.Protocol;

namespace Matchline.Extraction.Extractor
{
    /// <summary>Content hashing: the cache is addressed by the input's SHA-256.</summary>
    internal static class FileHasher
    {
        private const int BufferBytes = 1 << 20;

        /// <summary>
        /// Streams the file through SHA-256, reporting progress in bytes.
        /// Returns the lowercase hex digest.
        /// </summary>
        internal static string Sha256(string path, ProgressReporter reporter, Func<bool> isCancelled)
        {
            FileInfo info = new FileInfo(path);
            long total = info.Length;
            long done = 0;
            long sinceReport = 0;

            using (SHA256 algorithm = SHA256.Create())
            using (FileStream stream = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.Read, BufferBytes, FileOptions.SequentialScan))
            {
                byte[] buffer = new byte[BufferBytes];
                reporter.Progress(ExtractionStages.Hash, 0, total);

                while (true)
                {
                    int read = stream.Read(buffer, 0, buffer.Length);
                    if (read <= 0)
                    {
                        break;
                    }

                    algorithm.TransformBlock(buffer, 0, read, null, 0);
                    done += read;
                    sinceReport += read;

                    if (sinceReport >= 64L * 1024L * 1024L)
                    {
                        sinceReport = 0;
                        reporter.Progress(ExtractionStages.Hash, done, total);
                    }

                    if (isCancelled != null && isCancelled())
                    {
                        throw new OperationCanceledException();
                    }
                }

                algorithm.TransformFinalBlock(new byte[0], 0, 0);
                reporter.Progress(ExtractionStages.Hash, done, total);
                return ToHex(algorithm.Hash);
            }
        }

        private static string ToHex(byte[] bytes)
        {
            StringBuilder builder = new StringBuilder(bytes.Length * 2);
            for (int i = 0; i < bytes.Length; i++)
            {
                builder.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
            }

            return builder.ToString();
        }
    }
}
