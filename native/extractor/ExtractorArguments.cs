using System;
using System.IO;

namespace Matchline.Extraction.Extractor
{
    /// <summary>Parsed command line for the launcher.</summary>
    internal sealed class ExtractorArguments
    {
        internal const string UsageText =
            "Matchline.Extractor --input <file.nwd> [--cache-dir <dir>] [--navisworks-dir <dir>]\n" +
            "\n" +
            "  --input           NWD/NWF/NWC file to extract. Required.\n" +
            "  --cache-dir       Cache root. Default: %LOCALAPPDATA%\\Matchline\\cache\\models\n" +
            "  --navisworks-dir  Navisworks install folder (the one containing Roamer.exe).\n" +
            "                    Default: newest installed Navisworks Manage/Simulate.\n" +
            "\n" +
            "Emits JSON lines on stdout. Send a line reading 'cancel' on stdin to abort.";

        private ExtractorArguments()
        {
        }

        internal string InputPath { get; private set; }

        internal string CacheDirectory { get; private set; }

        /// <summary>Explicit Navisworks install folder, or null to auto-locate.</summary>
        internal string NavisworksDirectory { get; private set; }

        internal static bool TryParse(string[] args, out ExtractorArguments parsed, out string error)
        {
            parsed = null;
            error = null;

            string input = null;
            string cacheDir = null;
            string navisworksDir = null;

            if (args == null)
            {
                error = "No arguments supplied.\n" + UsageText;
                return false;
            }

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                switch (arg)
                {
                    case "--input":
                        if (!TryTakeValue(args, ref i, "--input", ref input, out error))
                        {
                            return false;
                        }

                        break;

                    case "--cache-dir":
                        if (!TryTakeValue(args, ref i, "--cache-dir", ref cacheDir, out error))
                        {
                            return false;
                        }

                        break;

                    case "--navisworks-dir":
                        if (!TryTakeValue(args, ref i, "--navisworks-dir", ref navisworksDir, out error))
                        {
                            return false;
                        }

                        break;

                    case "--help":
                    case "-h":
                    case "/?":
                        error = UsageText;
                        return false;

                    default:
                        error = "Unrecognised argument '" + arg + "'.\n" + UsageText;
                        return false;
                }
            }

            if (string.IsNullOrEmpty(input))
            {
                error = "--input is required.\n" + UsageText;
                return false;
            }

            ExtractorArguments result = new ExtractorArguments();

            try
            {
                result.InputPath = Path.GetFullPath(input);
                result.CacheDirectory = string.IsNullOrEmpty(cacheDir)
                    ? DefaultCacheDirectory()
                    : Path.GetFullPath(cacheDir);
                result.NavisworksDirectory = string.IsNullOrEmpty(navisworksDir)
                    ? null
                    : Path.GetFullPath(navisworksDir);
            }
            catch (ArgumentException ex)
            {
                error = "Malformed path: " + ex.Message;
                return false;
            }
            catch (NotSupportedException ex)
            {
                error = "Malformed path: " + ex.Message;
                return false;
            }
            catch (PathTooLongException ex)
            {
                error = "Path too long: " + ex.Message;
                return false;
            }

            parsed = result;
            return true;
        }

        internal static string DefaultCacheDirectory()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(localAppData, "Matchline", "cache", "models");
        }

        private static bool TryTakeValue(string[] args, ref int index, string name, ref string target, out string error)
        {
            if (index + 1 >= args.Length)
            {
                error = name + " requires a value.\n" + UsageText;
                return false;
            }

            index++;
            target = args[index];
            error = null;
            return true;
        }
    }
}
