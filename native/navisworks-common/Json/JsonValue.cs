using System;
using System.Collections.Generic;

namespace Matchline.Extraction.Json
{
    public enum JsonValueKind
    {
        Null = 0,
        String = 1,
        Number = 2,
        Boolean = 3,
        NumberArray = 4
    }

    /// <summary>
    /// One value inside a parsed NDJSON line. The protocol only ever produces
    /// the five kinds above, so there is no nested-object case.
    /// </summary>
    public sealed class JsonValue
    {
        public static readonly JsonValue Null = new JsonValue(JsonValueKind.Null);

        private JsonValue(JsonValueKind kind)
        {
            Kind = kind;
        }

        public JsonValueKind Kind { get; private set; }

        public string StringValue { get; private set; }

        public double NumberValue { get; private set; }

        public bool BooleanValue { get; private set; }

        public double[] ArrayValue { get; private set; }

        public static JsonValue FromString(string value)
        {
            JsonValue json = new JsonValue(JsonValueKind.String);
            json.StringValue = value;
            return json;
        }

        public static JsonValue FromNumber(double value)
        {
            JsonValue json = new JsonValue(JsonValueKind.Number);
            json.NumberValue = value;
            return json;
        }

        public static JsonValue FromBoolean(bool value)
        {
            JsonValue json = new JsonValue(JsonValueKind.Boolean);
            json.BooleanValue = value;
            return json;
        }

        public static JsonValue FromNumberArray(double[] values)
        {
            JsonValue json = new JsonValue(JsonValueKind.NumberArray);
            json.ArrayValue = values;
            return json;
        }
    }

    /// <summary>Typed accessors over one parsed NDJSON line.</summary>
    public sealed class JsonRecord
    {
        private readonly Dictionary<string, JsonValue> _fields;

        public JsonRecord(Dictionary<string, JsonValue> fields)
        {
            if (fields == null)
            {
                throw new ArgumentNullException("fields");
            }

            _fields = fields;
        }

        public bool Has(string name)
        {
            return _fields.ContainsKey(name);
        }

        /// <summary>Returns the string value, or null when absent or not a string.</summary>
        public string GetString(string name)
        {
            JsonValue value;
            if (!_fields.TryGetValue(name, out value) || value.Kind != JsonValueKind.String)
            {
                return null;
            }

            return value.StringValue;
        }

        public long GetInt64(string name, long fallback)
        {
            JsonValue value;
            if (!_fields.TryGetValue(name, out value) || value.Kind != JsonValueKind.Number)
            {
                return fallback;
            }

            return (long)value.NumberValue;
        }

        public long? GetNullableInt64(string name)
        {
            JsonValue value;
            if (!_fields.TryGetValue(name, out value) || value.Kind != JsonValueKind.Number)
            {
                return null;
            }

            return (long)value.NumberValue;
        }

        public int GetInt32(string name, int fallback)
        {
            return (int)GetInt64(name, fallback);
        }

        public bool GetBoolean(string name, bool fallback)
        {
            JsonValue value;
            if (!_fields.TryGetValue(name, out value) || value.Kind != JsonValueKind.Boolean)
            {
                return fallback;
            }

            return value.BooleanValue;
        }

        /// <summary>Returns the double array, or null when absent, null, or the wrong kind.</summary>
        public double[] GetDoubleArray(string name)
        {
            JsonValue value;
            if (!_fields.TryGetValue(name, out value) || value.Kind != JsonValueKind.NumberArray)
            {
                return null;
            }

            return value.ArrayValue;
        }
    }
}
