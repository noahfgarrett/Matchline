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
            "                    [--navisworks-version <year>] [--input-sha256 <hex>]\n" +
            "\n" +
            "  --input               NWD/NWF/NWC file to extract. Required.\n" +
            "  --cache-dir           Cache root. Default: %LOCALAPPDATA%\\Matchline\\cache\\models\n" +
            "  --navisworks-dir      Navisworks install folder (the one containing Roamer.exe).\n" +
            "                        Default: newest installed Navisworks Manage/Simulate.\n" +
            "  --navisworks-version  Use this release year instead of the newest installed one.\n" +
            "                        Adapters exist for " + SupportedAdapters.YearList() + ".\n" +
            "  --input-sha256        The input's SHA-256, already computed by the caller. Skips\n" +
            "                        the hash stage and is TRUSTED: pass it only when you hashed\n" +
            "                        the same bytes this run will read. 64 hex digits.\n" +
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

        /// <summary>
        /// The input's SHA-256 as the caller already computed it, or null to
        /// hash it here.
        /// <para>
        /// The cache is addressed by this value and the cache's own
        /// <c>input_sha256</c> meta row is written from it, so a caller that
        /// passes it is asserting that it hashed the very bytes this run will
        /// open. Matchline's own app is such a caller: it streams the hash when
        /// the file is registered, refuses to compile from a file whose bytes
        /// have changed since, and would otherwise pay for a second full read
        /// of a multi-gigabyte model on every extraction.
        /// </para>
        /// <para>
        /// Always 64 lowercase hex digits once parsed. Anything else is refused
        /// at parse time rather than reinterpreted: a malformed hash would
        /// become a cache file name, and a cache nobody can find again is worse
        /// than a wrong command line.
        /// </para>
        /// </summary>
        internal string InputSha256 { get; private set; }

        internal static bool TryParse(string[] args, out ExtractorArguments parsed, out string error)
        {
            parsed = null;
            error = null;

            string input = null;
            string cacheDir = null;
            string navisworksDir = null;
            string navisworksVersion = null;
            string inputSha256 = null;

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

                    case "--input-sha256":
                        if (!TryTakeValue(args, ref i, "--input-sha256", ref inputSha256, out error))
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

            string normalisedSha = null;
            // `!= null` rather than `IsNullOrEmpty`: passing the flag with an
            // empty value is a caller that meant to supply a hash and supplied
            // nothing, which is a wrong command line -- not the same fact as
            // never passing it at all.
            if (inputSha256 != null)
            {
                if (!TryNormaliseSha256(inputSha256, out normalisedSha))
                {
                    error = "--input-sha256 takes 64 hex digits, not '" + inputSha256 + "'.\n" + UsageText;
                    return false;
                }
            }

            ExtractorArguments result = new ExtractorArguments();
            result.NavisworksYear = year;
            result.InputSha256 = normalisedSha;

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

        /// <summary>
        /// A SHA-256 in the one spelling everything downstream uses: 64
        /// lowercase hex digits.
        /// <para>
        /// Upper case is accepted and folded, because a hash is the same number
        /// either way and refusing a caller over letter case would be pedantry.
        /// Everything else -- a short digest, a long one, a "0x" prefix, a
        /// non-hex character -- is refused: the value becomes a file name and a
        /// path, and there is no safe way to guess what was meant.
        /// </para>
        /// </summary>
        internal static bool TryNormaliseSha256(string value, out string normalised)
        {
            normalised = null;
            if (value == null || value.Length != 64)
            {
                return false;
            }

            char[] folded = new char[64];
            for (int i = 0; i < 64; i++)
            {
                char c = value[i];
                if (c >= '0' && c <= '9')
                {
                    folded[i] = c;
                }
                else if (c >= 'a' && c <= 'f')
                {
                    folded[i] = c;
                }
                else if (c >= 'A' && c <= 'F')
                {
                    folded[i] = (char)(c + ('a' - 'A'));
                }
                else
                {
                    return false;
                }
            }

            normalised = new string(folded);
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
