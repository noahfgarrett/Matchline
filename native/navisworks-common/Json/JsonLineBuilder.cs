using System.Globalization;
using System.Text;

namespace Matchline.Extraction.Json
{
    /// <summary>
    /// Minimal JSON object emitter for one NDJSON line.
    /// <para>
    /// Dependency-free on purpose: this type is loaded inside the Navisworks
    /// process, where an extra assembly (Newtonsoft and friends) risks colliding
    /// with a copy Autodesk already loaded. Only the shapes the NDJSON protocol
    /// uses are supported: a flat object whose values are string, integer,
    /// double, bool, null, or an array of doubles.
    /// </para>
    /// <para>
    /// Every number is formatted with <see cref="CultureInfo.InvariantCulture"/>.
    /// Instances are NOT thread-safe; each writer owns one.
    /// </para>
    /// </summary>
    public sealed class JsonLineBuilder
    {
        private readonly StringBuilder _builder = new StringBuilder(512);
        private bool _hasField;

        /// <summary>Resets the builder and opens a new object.</summary>
        public JsonLineBuilder Begin()
        {
            _builder.Length = 0;
            _hasField = false;
            _builder.Append('{');
            return this;
        }

        public JsonLineBuilder AddString(string name, string value)
        {
            StartField(name);
            if (value == null)
            {
                _builder.Append("null");
            }
            else
            {
                AppendEscaped(_builder, value);
            }

            return this;
        }

        public JsonLineBuilder AddInt(string name, long value)
        {
            StartField(name);
            _builder.Append(value.ToString(CultureInfo.InvariantCulture));
            return this;
        }

        public JsonLineBuilder AddNullableInt(string name, long? value)
        {
            if (value.HasValue)
            {
                return AddInt(name, value.Value);
            }

            StartField(name);
            _builder.Append("null");
            return this;
        }

        public JsonLineBuilder AddBool(string name, bool value)
        {
            StartField(name);
            _builder.Append(value ? "true" : "false");
            return this;
        }

        public JsonLineBuilder AddDoubleArray(string name, double[] values)
        {
            StartField(name);
            if (values == null)
            {
                _builder.Append("null");
                return this;
            }

            _builder.Append('[');
            for (int i = 0; i < values.Length; i++)
            {
                if (i > 0)
                {
                    _builder.Append(',');
                }

                AppendDouble(_builder, values[i]);
            }

            _builder.Append(']');
            return this;
        }

        /// <summary>Closes the object and returns the line (no trailing newline).</summary>
        public string End()
        {
            _builder.Append('}');
            return _builder.ToString();
        }

        private void StartField(string name)
        {
            if (_hasField)
            {
                _builder.Append(',');
            }

            _hasField = true;
            AppendEscaped(_builder, name);
            _builder.Append(':');
        }

        private static void AppendDouble(StringBuilder builder, double value)
        {
            // NaN and the infinities have no JSON spelling; record them as null
            // rather than emitting a line no parser will accept.
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                builder.Append("null");
                return;
            }

            builder.Append(value.ToString("R", CultureInfo.InvariantCulture));
        }

        private static void AppendEscaped(StringBuilder builder, string value)
        {
            builder.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '\b':
                        builder.Append("\\b");
                        break;
                    case '\f':
                        builder.Append("\\f");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (c < ' ')
                        {
                            builder.Append("\\u");
                            builder.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(c);
                        }

                        break;
                }
            }

            builder.Append('"');
        }
    }
}
