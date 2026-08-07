using System;
using System.IO;
using System.Text;
using Matchline.Extraction.Protocol;

namespace Matchline.Extraction.Extractor
{
    /// <summary>
    /// Entry point for the extraction launcher.
    /// <para>
    /// stdout carries the JSON-lines protocol and nothing else -- anything
    /// diagnostic goes to stderr, so a parent process can parse stdout blindly.
    /// </para>
    /// </summary>
    internal static class Program
    {
        internal static int Main(string[] args)
        {
            using (ProgressReporter reporter = CreateReporter())
            {
                try
                {
                    ExtractorArguments arguments;
                    string error;
                    if (!ExtractorArguments.TryParse(args, out arguments, out error))
                    {
                        reporter.Error(ExtractionErrorCodes.InvalidArguments, error);
                        return ExitCodes.InvalidArguments;
                    }

                    ExtractionRunner runner = new ExtractionRunner(arguments, reporter);
                    return runner.Run();
                }
                catch (Exception ex)
                {
                    // Last resort: the runner handles its own failures, so
                    // reaching here means something outside the pipeline broke.
                    reporter.Error(ExtractionErrorCodes.Internal, ex.GetType().Name + ": " + ex.Message);
                    return ExitCodes.Internal;
                }
            }
        }

        private static ProgressReporter CreateReporter()
        {
            Stream stdout = Console.OpenStandardOutput();
            StreamWriter writer = new StreamWriter(stdout, new UTF8Encoding(false));
            writer.AutoFlush = true;
            return new ProgressReporter(writer, true);
        }
    }
}
