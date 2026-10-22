using System.Text.Json;
using System.Text.RegularExpressions;
using TinadecCore.Contracts.Dtos;

namespace TinadecCore.DmaEA;

internal static class EvalSuiteContract
{
    public const int SchemaVersion = 1;
    public const int MaxCases = 20;
    public const int MaxAssertionsPerCase = 10;
    public const int MaxInputLength = 8000;
    public const int MaxAssertionTextLength = 2000;
    public const int MaxDefinitionBytes = 256 * 1024;
    public const decimal MaxWeight = 100m;
    public static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(2);
    public static readonly Regex IdentifierPattern = new("^[a-z0-9][a-z0-9._-]*$", RegexOptions.CultureInvariant);
}

internal static class EvalAssertionTypes
{
    public const string Contains = "contains";
    public const string NotContains = "not_contains";
    public const string Regex = "regex";
    public const string MinChars = "min_chars";
    public const string MaxChars = "max_chars";

    public static bool IsKnown(string? type) =>
        type is Contains or NotContains or Regex or MinChars or MaxChars;
}

internal sealed record EvalGateDefinition(decimal MinPassRate, decimal MaxRegression)
{
    public static EvalGateDefinition Default => new(1m, 0m);
}

internal sealed class EvalSuiteDefinition
{
    public int SchemaVersion { get; init; } = EvalSuiteContract.SchemaVersion;
    public string Slug { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string? Description { get; init; }
    public EvalGateDefinition Gate { get; init; } = EvalGateDefinition.Default;
    public List<EvalCaseDefinition> Cases { get; init; } = [];
}

internal sealed class EvalCaseDefinition
{
    public string Id { get; init; } = string.Empty;
    public string Input { get; init; } = string.Empty;
    public bool Required { get; init; } = true;
    public decimal Weight { get; init; } = 1m;
    public List<EvalAssertionDefinition> Assertions { get; init; } = [];
}

internal sealed class EvalAssertionDefinition
{
    public string Type { get; init; } = string.Empty;
    public string? Text { get; init; }
    public int? Number { get; init; }

    public bool IsTextType => Type is EvalAssertionTypes.Contains or EvalAssertionTypes.NotContains or EvalAssertionTypes.Regex;
}

internal static class EvalSuiteValidator
{
    public static EvalSuiteDefinition FromRequest(CreateEvalSuiteRequest? request)
    {
        if (request is null) throw new InvalidDataException("Suite body is required.");
        var schemaVersion = request.SchemaVersion ?? EvalSuiteContract.SchemaVersion;
        if (schemaVersion != EvalSuiteContract.SchemaVersion)
            throw new InvalidDataException($"schema_version must be {EvalSuiteContract.SchemaVersion}.");
        var slug = RequireText(request.Slug, "slug", 128);
        if (!EvalSuiteContract.IdentifierPattern.IsMatch(slug))
            throw new InvalidDataException("slug must match ^[a-z0-9][a-z0-9._-]*$.");
        var name = RequireText(request.Name, "name", 256);
        var description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim();
        if (description is { Length: > 2000 }) throw new InvalidDataException("description must be at most 2000 characters.");
        var gate = ValidateGate(request.Gate);
        var cases = ValidateCases(request.Cases);
        var definition = new EvalSuiteDefinition
        {
            SchemaVersion = schemaVersion,
            Slug = slug,
            Name = name,
            Description = description,
            Gate = gate,
            Cases = cases
        };
        var bytes = EvalSuiteJson.Serialize(definition);
        if (bytes.Length > EvalSuiteContract.MaxDefinitionBytes)
            throw new InvalidDataException($"Suite definition must be at most {EvalSuiteContract.MaxDefinitionBytes} bytes.");
        return definition;
    }

    public static EvalSuiteDefinition FromCanonical(ReadOnlySpan<byte> json)
    {
        EvalSuiteDocument? document;
        try
        {
            document = JsonSerializer.Deserialize<EvalSuiteDocument>(json, EvalSuiteJson.ReadOptions);
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("Stored suite definition is not valid JSON.", ex);
        }
        if (document is null) throw new InvalidDataException("Stored suite definition is empty.");
        if (document.SchemaVersion != EvalSuiteContract.SchemaVersion)
            throw new InvalidDataException($"schema_version must be {EvalSuiteContract.SchemaVersion}.");
        return new EvalSuiteDefinition
        {
            SchemaVersion = document.SchemaVersion,
            Slug = document.Slug,
            Name = document.Name,
            Description = document.Description,
            Gate = document.Gate,
            Cases = document.Cases.Select(c => new EvalCaseDefinition
            {
                Id = c.Id,
                Input = c.Input,
                Required = c.Required,
                Weight = c.Weight,
                Assertions = c.Assertions.Select(ToAssertion).ToList()
            }).ToList()
        };
    }

    private static EvalGateDefinition ValidateGate(EvalGateRequest? request)
    {
        var minPassRate = request?.MinPassRate ?? 1m;
        var maxRegression = request?.MaxRegression ?? 0m;
        if (minPassRate is < 0m or > 1m) throw new InvalidDataException("gate.min_pass_rate must be in [0,1].");
        if (maxRegression is < 0m or > 1m) throw new InvalidDataException("gate.max_regression must be in [0,1].");
        return new EvalGateDefinition(minPassRate, maxRegression);
    }

    private static List<EvalCaseDefinition> ValidateCases(List<EvalCaseRequest>? request)
    {
        if (request is null || request.Count == 0) throw new InvalidDataException("cases must contain 1 to 20 entries.");
        if (request.Count > EvalSuiteContract.MaxCases)
            throw new InvalidDataException($"cases must contain at most {EvalSuiteContract.MaxCases} entries.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<EvalCaseDefinition>(request.Count);
        foreach (var item in request)
        {
            if (item is null) throw new InvalidDataException("Each case must be an object.");
            var id = RequireText(item.Id, "case.id", 128);
            if (!EvalSuiteContract.IdentifierPattern.IsMatch(id))
                throw new InvalidDataException($"case id '{id}' must match ^[a-z0-9][a-z0-9._-]*$.");
            if (!ids.Add(id)) throw new InvalidDataException($"case id '{id}' is duplicated.");
            var input = item.Input ?? string.Empty;
            if (input.Length is < 1 or > EvalSuiteContract.MaxInputLength)
                throw new InvalidDataException($"case '{id}' input must be 1 to {EvalSuiteContract.MaxInputLength} characters.");
            var weight = item.Weight ?? 1m;
            if (weight is <= 0m or > EvalSuiteContract.MaxWeight)
                throw new InvalidDataException($"case '{id}' weight must be in (0,{EvalSuiteContract.MaxWeight}].");
            var assertions = ValidateAssertions(id, item.Assertions);
            var minChars = assertions.FirstOrDefault(a => a.Type == EvalAssertionTypes.MinChars)?.Number;
            var maxChars = assertions.FirstOrDefault(a => a.Type == EvalAssertionTypes.MaxChars)?.Number;
            if (minChars is not null && maxChars is not null && minChars > maxChars)
                throw new InvalidDataException($"case '{id}' min_chars must not exceed max_chars.");
            result.Add(new EvalCaseDefinition
            {
                Id = id,
                Input = input,
                Required = item.Required ?? true,
                Weight = weight,
                Assertions = assertions
            });
        }
        return result;
    }

    private static List<EvalAssertionDefinition> ValidateAssertions(string caseId, List<EvalAssertionRequest>? request)
    {
        if (request is null || request.Count == 0)
            throw new InvalidDataException($"case '{caseId}' must contain 1 to {EvalSuiteContract.MaxAssertionsPerCase} assertions.");
        if (request.Count > EvalSuiteContract.MaxAssertionsPerCase)
            throw new InvalidDataException($"case '{caseId}' must contain at most {EvalSuiteContract.MaxAssertionsPerCase} assertions.");
        var result = new List<EvalAssertionDefinition>(request.Count);
        foreach (var item in request)
        {
            if (item is null) throw new InvalidDataException($"case '{caseId}' contains a null assertion.");
            var type = item.Type?.Trim().ToLowerInvariant() ?? string.Empty;
            if (!EvalAssertionTypes.IsKnown(type))
                throw new InvalidDataException($"case '{caseId}' has unknown assertion type '{item.Type}'.");
            if (type is EvalAssertionTypes.Contains or EvalAssertionTypes.NotContains or EvalAssertionTypes.Regex)
            {
                if (item.Value.ValueKind != JsonValueKind.String)
                    throw new InvalidDataException($"case '{caseId}' assertion '{type}' requires a string value.");
                var text = item.Value.GetString() ?? string.Empty;
                if (text.Length is < 1 or > EvalSuiteContract.MaxAssertionTextLength)
                    throw new InvalidDataException($"case '{caseId}' assertion '{type}' value must be 1 to {EvalSuiteContract.MaxAssertionTextLength} characters.");
                if (type == EvalAssertionTypes.Regex)
                {
                    try
                    {
                        _ = new Regex(text, RegexOptions.CultureInvariant, EvalSuiteContract.RegexTimeout);
                    }
                    catch (ArgumentException ex)
                    {
                        throw new InvalidDataException($"case '{caseId}' has an invalid regex: {ex.Message}", ex);
                    }
                }
                result.Add(new EvalAssertionDefinition { Type = type, Text = text });
            }
            else
            {
                if (item.Value.ValueKind != JsonValueKind.Number || !item.Value.TryGetInt64(out var number))
                    throw new InvalidDataException($"case '{caseId}' assertion '{type}' requires an integer value.");
                if (number is < 0 or > int.MaxValue)
                    throw new InvalidDataException($"case '{caseId}' assertion '{type}' value must be between 0 and {int.MaxValue}.");
                result.Add(new EvalAssertionDefinition { Type = type, Number = (int)number });
            }
        }
        return result;
    }

    private static EvalAssertionDefinition ToAssertion(EvalAssertionDocument document)
    {
        if (!EvalAssertionTypes.IsKnown(document.Type))
            throw new InvalidDataException($"Stored suite assertion type '{document.Type}' is unknown.");
        if (document.Type is EvalAssertionTypes.Contains or EvalAssertionTypes.NotContains or EvalAssertionTypes.Regex)
        {
            if (document.Value.ValueKind != JsonValueKind.String)
                throw new InvalidDataException($"Stored suite assertion '{document.Type}' is missing its string value.");
            return new EvalAssertionDefinition { Type = document.Type, Text = document.Value.GetString() };
        }
        if (document.Value.ValueKind != JsonValueKind.Number || !document.Value.TryGetInt64(out var number))
            throw new InvalidDataException($"Stored suite assertion '{document.Type}' is missing its integer value.");
        return new EvalAssertionDefinition { Type = document.Type, Number = (int)number };
    }

    private static string RequireText(string? value, string field, int maxLength)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text)) throw new InvalidDataException($"{field} is required.");
        if (text.Length > maxLength) throw new InvalidDataException($"{field} must be at most {maxLength} characters.");
        return text;
    }

    private sealed class EvalSuiteDocument
    {
        public int SchemaVersion { get; init; }
        public string Slug { get; init; } = string.Empty;
        public string Name { get; init; } = string.Empty;
        public string? Description { get; init; }
        public EvalGateDefinition Gate { get; init; } = EvalGateDefinition.Default;
        public List<EvalCaseDocument> Cases { get; init; } = [];
    }

    private sealed class EvalCaseDocument
    {
        public string Id { get; init; } = string.Empty;
        public string Input { get; init; } = string.Empty;
        public bool Required { get; init; } = true;
        public decimal Weight { get; init; } = 1m;
        public List<EvalAssertionDocument> Assertions { get; init; } = [];
    }

    private sealed class EvalAssertionDocument
    {
        public string Type { get; init; } = string.Empty;
        public JsonElement Value { get; init; }
    }
}

internal static class EvalSuiteJson
{
    internal static readonly JsonSerializerOptions ReadOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    /// <summary>
    /// Hand-written property order keeps the content hash stable regardless of
    /// reflection ordering; the stored bytes are the authority for suite identity.
    /// </summary>
    public static byte[] Serialize(EvalSuiteDefinition suite)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schema_version", suite.SchemaVersion);
            writer.WriteString("slug", suite.Slug);
            writer.WriteString("name", suite.Name);
            writer.WriteString("description", suite.Description);
            writer.WriteStartObject("gate");
            writer.WriteNumber("min_pass_rate", suite.Gate.MinPassRate);
            writer.WriteNumber("max_regression", suite.Gate.MaxRegression);
            writer.WriteEndObject();
            writer.WriteStartArray("cases");
            foreach (var item in suite.Cases)
            {
                writer.WriteStartObject();
                writer.WriteString("id", item.Id);
                writer.WriteString("input", item.Input);
                writer.WriteBoolean("required", item.Required);
                writer.WriteNumber("weight", item.Weight);
                writer.WriteStartArray("assertions");
                foreach (var assertion in item.Assertions)
                {
                    writer.WriteStartObject();
                    writer.WriteString("type", assertion.Type);
                    if (assertion.IsTextType) writer.WriteString("value", assertion.Text);
                    else writer.WriteNumber("value", assertion.Number ?? 0);
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }
}

internal sealed record EvalReport
{
    public int SchemaVersion { get; init; } = 1;
    public EvalReportSuite Suite { get; init; } = new();
    public EvalReportControl Control { get; init; } = new();
    public EvalReportTreatment Treatment { get; init; } = new();
    public EvalReportModel Model { get; init; } = new();
    public string Status { get; init; } = "completed";
    public EvalReportGate Gate { get; init; } = new();
    public EvalReportUsageSection Usage { get; init; } = new();
    public List<EvalReportCase> Cases { get; init; } = [];
    public string? Error { get; init; }
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
}

internal sealed class EvalReportSuite
{
    public Guid Id { get; init; }
    public string Slug { get; init; } = string.Empty;
    public string Hash { get; init; } = string.Empty;
    public EvalGateDefinition Gate { get; init; } = EvalGateDefinition.Default;
}

internal sealed class EvalReportControl
{
    public Guid? AgentDefinitionId { get; init; }
    public Guid? AgentVersionId { get; init; }
    public string? VersionHash { get; init; }
    public string? SystemPromptHash { get; init; }
}

internal sealed class EvalReportTreatment
{
    public string ProposalHash { get; init; } = string.Empty;
    public string? SystemPromptHash { get; init; }
}

internal sealed record EvalReportModel
{
    public string Route { get; init; } = "chat";
    public string? Model { get; init; }
    public string? ModelId { get; init; }
    public string? Protocol { get; init; }
}

internal sealed class EvalReportGate
{
    public string Status { get; init; } = "failed";
    public List<EvalGateFailure> Failures { get; init; } = [];
    public int CasesTotal { get; init; }
    public int CasesPassed { get; init; }
    public int CasesFailed { get; init; }
    public int CasesBlocked { get; init; }
    public int EligiblePairs { get; init; }
    public int BlockedPairs { get; init; }
    public decimal? ControlPassRate { get; init; }
    public decimal? TreatmentPassRate { get; init; }
    public decimal WeightedPassRate { get; init; }
    public decimal Lift { get; init; }
    public List<string> Flags { get; init; } = [];
}

internal sealed class EvalReportUsageSection
{
    public EvalReportUsage Control { get; init; } = new();
    public EvalReportUsage Treatment { get; init; } = new();
}

internal sealed class EvalReportUsage
{
    public long InputTokens { get; init; }
    public long OutputTokens { get; init; }
    public long TotalTokens { get; init; }
}

internal sealed class EvalReportCase
{
    public string Id { get; init; } = string.Empty;
    public bool Required { get; init; }
    public decimal Weight { get; init; }
    public string Status { get; init; } = "blocked";
    public long ElapsedMs { get; init; }
    public EvalReportArm Control { get; init; } = new();
    public EvalReportArm Treatment { get; init; } = new();
}

internal sealed class EvalReportArm
{
    public string Status { get; init; } = "error";
    public List<EvalReportAssertion> Assertions { get; init; } = [];
    public string? OutputExcerpt { get; init; }
    public string? OutputSha256 { get; init; }
    public int OutputLength { get; init; }
    public long ElapsedMs { get; init; }
    public string? Error { get; init; }
}

internal sealed class EvalReportAssertion
{
    public string Type { get; init; } = string.Empty;
    public bool Passed { get; init; }
    public string? Detail { get; init; }
}
