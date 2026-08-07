using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Matchline.Extraction.Json
{
    /// <summary>Thrown when an NDJSON line is not the shape the protocol defines.</summary>
    public sealed class JsonParseException : Exception
    {
        public JsonParseException(string message)
            : base(message)
        {
        }
    }

    /// <summary>
    /// Parser for one NDJSON line, matching exactly what <see cref="JsonLineBuilder"/>
    /// emits: a flat object whose values are string, number, bool, null, or an
    /// array of numbers. Nested objects are rejected rather than silently skipped,
    /// so a protocol drift shows up as a loud failure instead of missing data.
    /// </summary>
    public static class JsonLineParser
    {
        public static JsonRecord Parse(string line)
        {
            if (line == null)
            {
                throw new JsonParseException("line is null");
            }

            int index = 0;
            SkipWhitespace(line, ref index);
            Expect(line, ref index, '{');

            Dictionary<string, JsonValue> fields = new Dictionary<string, JsonValue>(StringComparer.Ordinal);

            SkipWhitespace(line, ref index);
            if (Peek(line, index) == '}')
            {
                index++;
                return new JsonRecord(fields);
            }

            while (true)
            {
                SkipWhitespace(line, ref index);
                string key = ParseString(line, ref index);
                SkipWhitespace(line, ref index);
                Expect(line, ref index, ':');
                SkipWhitespace(line, ref index);
                fields[key] = ParseValue(line, ref index);
                SkipWhitespace(line, ref index);

                char next = Peek(line, index);
                if (next == ',')
                {
                    index++;
                    continue;
                }

                if (next == '}')
                {
                    index++;
                    break;
                }

                throw Error(index, "expected ',' or '}'");
            }

            return new JsonRecord(fields);
        }

        private static JsonValue ParseValue(string line, ref int index)
        {
            char c = Peek(line, index);
            switch (c)
            {
                case '"':
                    return JsonValue.FromString(ParseString(line, ref index));
                case '[':
                    return JsonValue.FromNumberArray(ParseNumberArray(line, ref index));
                case 't':
                    ExpectLiteral(line, ref index, "true");
                    return JsonValue.FromBoolean(true);
                case 'f':
                    ExpectLiteral(line, ref index, "false");
                    return JsonValue.FromBoolean(false);
                case 'n':
                    ExpectLiteral(line, ref index, "null");
                    return JsonValue.Null;
                case '{':
                    throw Error(index, "nested objects are not part of the NDJSON protocol");
                default:
                    return JsonValue.FromNumber(ParseNumber(line, ref index));
            }
        }

        private static double[] ParseNumberArray(string line, ref int index)
        {
            Expect(line, ref index, '[');
            List<double> values = new List<double>(6);

            SkipWhitespace(line, ref index);
            if (Peek(line, index) == ']')
            {
                index++;
                return values.ToArray();
            }

            while (true)
            {
                SkipWhitespace(line, ref index);
                if (Peek(line, index) == 'n')
                {
                    ExpectLiteral(line, ref index, "null");
                    values.Add(double.NaN);
                }
                else
                {
                    values.Add(ParseNumber(line, ref index));
                }

                SkipWhitespace(line, ref index);
                char next = Peek(line, index);
                if (next == ',')
                {
                    index++;
                    continue;
                }

                if (next == ']')
                {
                    index++;
                    break;
                }

                throw Error(index, "expected ',' or ']'");
            }

            return values.ToArray();
        }

        private static double ParseNumber(string line, ref int index)
        {
            int start = index;
            while (index < line.Length)
            {
                char c = line[index];
                bool isNumberChar = (c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E';
                if (!isNumberChar)
                {
                    break;
                }

                index++;
            }

            if (index == start)
            {
                throw Error(index, "expected a number");
            }

            string text = line.Substring(start, index - start);
            double value;
            if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value))
            {
                throw Error(start, "malformed number '" + text + "'");
            }

            return value;
        }

        private static string ParseString(string line, ref int index)
        {
            Expect(line, ref index, '"');
            StringBuilder builder = new StringBuilder(32);

            while (true)
            {
                if (index >= line.Length)
                {
                    throw Error(index, "unterminated string");
                }

                char c = line[index++];
                if (c == '"')
                {
                    break;
                }

                if (c != '\\')
                {
                    builder.Append(c);
                    continue;
                }

                if (index >= line.Length)
                {
                    throw Error(index, "unterminated escape sequence");
                }

                char escape = line[index++];
                switch (escape)
                {
                    case '"':
                        builder.Append('"');
                        break;
                    case '\\':
                        builder.Append('\\');
                        break;
                    case '/':
                        builder.Append('/');
                        break;
                    case 'b':
                        builder.Append('\b');
                        break;
                    case 'f':
                        builder.Append('\f');
                        break;
                    case 'n':
                        builder.Append('\n');
                        break;
                    case 'r':
                        builder.Append('\r');
                        break;
                    case 't':
                        builder.Append('\t');
                        break;
                    case 'u':
                        if (index + 4 > line.Length)
                        {
                            throw Error(index, "truncated \\u escape");
                        }

                        string hex = line.Substring(index, 4);
                        int code;
                        if (!int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                        {
                            throw Error(index, "malformed \\u escape '" + hex + "'");
                        }

                        builder.Append((char)code);
                        index += 4;
                        break;
                    default:
                        throw Error(index, "unsupported escape '\\" + escape + "'");
                }
            }

            return builder.ToString();
        }

        private static void SkipWhitespace(string line, ref int index)
        {
            while (index < line.Length)
            {
                char c = line[index];
                if (c != ' ' && c != '\t' && c != '\r' && c != '\n')
                {
                    break;
                }

                index++;
            }
        }

        private static char Peek(string line, int index)
        {
            return index < line.Length ? line[index] : '\0';
        }

        private static void Expect(string line, ref int index, char expected)
        {
            if (Peek(line, index) != expected)
            {
                throw Error(index, "expected '" + expected + "'");
            }

            index++;
        }

        private static void ExpectLiteral(string line, ref int index, string literal)
        {
            if (index + literal.Length > line.Length ||
                string.CompareOrdinal(line, index, literal, 0, literal.Length) != 0)
            {
                throw Error(index, "expected '" + literal + "'");
            }

            index += literal.Length;
        }

        private static JsonParseException Error(int index, string message)
        {
            return new JsonParseException(
                "NDJSON parse error at offset " + index.ToString(CultureInfo.InvariantCulture) + ": " + message);
        }
    }
}
