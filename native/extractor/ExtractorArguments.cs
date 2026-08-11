using System;
using System.Globalization;
using System.IO;
using Matchline.Extraction.Protocol;

namespace Matchline.Extraction.Extractor
{
    /// <summary>Parsed command line for the launcher.</summary>
    internal sealed class ExtractorArguments
    {
        internal static readonly string UsageText =
            "Matchline.Extractor --input <file.nwd> [--cache-dir <dir>] [--navisworks-dir <dir>]\n" +
            "                    [--navisworks-version <year>]\n" +
            "\n" +
            "  --input               NWD/NWF/NWC file to extract. Required.\n" +
            "  --cache-dir           Cache root. Default: %LOCALAPPDATA%\\Matchline\\cache\\models\n" +
            "  --navisworks-dir      Navisworks install folder (the one containing Roamer.exe).\n" +
            "                        Default: newest installed Navisworks Manage/Simulate.\n" +
            "  --navisworks-version  Use this release year instead of the newest installed one.\n" +
            "                        Adapters exist for " + SupportedAdapters.YearList() + ".\n" +
            "\n" +
            "Emits JSON lines on stdout. Send a line reading 'cancel' on stdin to abort.";

        private ExtractorArguments()
        {
        }

        internal string InputPath { get; private set; }

        internal string CacheDirectory { get; private set; }

        /// <summary>Explicit Navisworks install folder, or null to auto-locate.</summary>
        internal string NavisworksDirectory { get; private set; }

        /// <summary>
        /// Explicit Navisworks release year, or null for "newest installed".
        /// Always a year <see cref="SupportedAdapters"/> knows: parsing rejects
        /// anything else, so nothing downstream has to re-check.
        /// </summary>
        internal int? NavisworksYear { get; private set; }

        internal static bool TryParse(string[] args, out ExtractorArguments parsed, out string error)
        {
            parsed = null;
            error = null;

            string input = null;
            string cacheDir = null;
            string navisworksDir = null;
            string navisworksVersion = null;

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

                    case "--navisworks-version":
                        if (!TryTakeValue(args, ref i, "--navisworks-version", ref navisworksVersion, out error))
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

            int? year = null;
            if (!string.IsNullOrEmpty(navisworksVersion))
            {
                // Both flags pin the install, and they can disagree. Refusing is
                // better than silently letting one win: the caller learns which
                // one it actually meant.
                if (!string.IsNullOrEmpty(navisworksDir))
                {
                    error = "--navisworks-dir and --navisworks-version both choose the install to use. " +
                        "Pass one or the other.\n" + UsageText;
                    return false;
                }

                int parsedYear;
                if (!int.TryParse(
                        navisworksVersion, NumberStyles.None, CultureInfo.InvariantCulture, out parsedYear))
                {
                    error = "--navisworks-version takes a release year, not '" + navisworksVersion + "'.\n" +
                        UsageText;
                    return false;
                }

                // Rejected here rather than at locate time: asking for a year
                // Matchline has no adapter for is a wrong command line, and the
                // answer does not depend on what happens to be installed.
                if (!SupportedAdapters.IsSupported(parsedYear))
                {
                    error = "Matchline has no adapter for Navisworks " +
                        parsedYear.ToString(CultureInfo.InvariantCulture) +
                        ". Adapters exist for " + SupportedAdapters.YearList() + ".\n" + UsageText;
                    return false;
                }

                year = parsedYear;
            }

            ExtractorArguments result = new ExtractorArguments();
            result.NavisworksYear = year;

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
