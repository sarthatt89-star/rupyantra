# Portfolio analysis: expected return, volatility, correlation, diversification and risk/return comparison.
# Inputs are PERCENT numbers (12 means 12%). Weights are fractions that add up to 1 (long-only, no short selling).
# Results describe a model built from the numbers you supply; they are not predictions or guaranteed returns.

const MAX_ASSETS = 50
const MAX_OBSERVATIONS = 2000

function _numbers(x, name::AbstractString, lo::Real, hi::Real; n = nothing)
    (x isa AbstractVector && !isempty(x)) || throw(InvalidInput("$name must be a non-empty list"))
    length(x) <= MAX_ASSETS || throw(InvalidInput("$name has too many items (max $MAX_ASSETS)"))
    n === nothing || length(x) == n || throw(InvalidInput("$name must have $n items"))
    return Float64[check_range(v, name, lo, hi) for v in x]
end

function _weights(x, n)
    w = _numbers(x, "weights", 0, 1; n = n)
    abs(sum(w) - 1) <= 1e-6 || throw(InvalidInput("weights must add up to 1"))
    return w
end

# correlations: list of rows; nothing -> assets treated as uncorrelated (this is reported back to the caller)
function _correlations(x, n)
    x === nothing && return Matrix{Float64}(I, n, n), true
    (x isa AbstractVector && length(x) == n) || throw(InvalidInput("correlations must be a $n x $n matrix"))
    C = zeros(n, n)
    for i in 1:n
        row = x[i]
        (row isa AbstractVector && length(row) == n) || throw(InvalidInput("correlations must be a $n x $n matrix"))
        for j in 1:n
            C[i, j] = check_range(row[j], "correlation", -1, 1)
        end
    end
    for i in 1:n
        abs(C[i, i] - 1) <= 1e-9 || throw(InvalidInput("correlation diagonal must be 1"))
        for j in (i + 1):n
            abs(C[i, j] - C[j, i]) <= 1e-9 || throw(InvalidInput("correlation matrix must be symmetric"))
        end
    end
    minimum(eigvals(Symmetric(C))) >= -1e-8 || throw(InvalidInput("correlation matrix is not valid (not positive semi-definite)"))
    return C, false
end

function _metrics(w, mu, sd, C, rf)
    S = (sd * sd') .* C                      # covariance matrix (decimals)
    var = w' * S * w
    vol = sqrt(max(var, 0.0))
    ret = sum(w .* mu)
    wavg = sum(w .* sd)
    contrib = vol > 0 ? 100 .* (w .* (S * w)) ./ var : fill(NaN, length(w))
    out = Dict{String,Any}(
        "expected_return_percent" => ret,
        "volatility_percent" => 100 * vol,
        "weighted_average_volatility_percent" => 100 * wavg,
        "diversification_ratio" => vol > 0 ? wavg / vol : nothing,
        "diversification_benefit_percent" => wavg > 0 ? 100 * (1 - vol / wavg) : 0.0,
        "effective_number_of_assets" => 1 / sum(w .^ 2),
        "largest_weight" => maximum(w),
        "risk_contribution_percent" => vol > 0 ? collect(contrib) : nothing,
        "sharpe_ratio" => vol > 0 ? (ret - rf) / (100 * vol) : nothing,
    )
    return out
end

"""
portfolio_analysis(; weights, expected_returns, volatilities, correlations=nothing, risk_free_rate=0)
Expected return, volatility, risk contribution of each asset, diversification measures and Sharpe ratio.
"""
function portfolio_analysis(; weights, expected_returns, volatilities, correlations = nothing, risk_free_rate = 0)
    (weights isa AbstractVector && !isempty(weights)) || throw(InvalidInput("weights must be a non-empty list"))
    n = length(weights)
    w = _weights(weights, n)
    mu = _numbers(expected_returns, "expected_returns", -50, 100; n = n)
    sd = _numbers(volatilities, "volatilities", 0, 100; n = n) ./ 100
    rf = check_range(risk_free_rate, "risk_free_rate", -10, 50)
    C, assumed = _correlations(correlations, n)
    out = _metrics(w, mu, sd, C, rf)
    out["assets"] = n
    out["correlations_assumed_zero"] = assumed
    out["risk_free_rate_percent"] = rf
    return out
end

"""
portfolio_compare(; portfolios, expected_returns, volatilities, correlations=nothing, risk_free_rate=0)
`portfolios` is a list of {"name": ..., "weights": [...]} over the same assets.
"""
function portfolio_compare(; portfolios, expected_returns, volatilities, correlations = nothing, risk_free_rate = 0)
    (portfolios isa AbstractVector && 2 <= length(portfolios) <= 10) || throw(InvalidInput("portfolios must be a list of 2 to 10 portfolios"))
    rows = Dict{String,Any}[]
    for (i, p) in enumerate(portfolios)
        (p isa AbstractDict && haskey(p, "weights")) || throw(InvalidInput("each portfolio needs weights"))
        name = get(p, "name", "Portfolio $i")
        (name isa AbstractString && length(name) <= 40) || throw(InvalidInput("portfolio name must be text up to 40 characters"))
        r = portfolio_analysis(; weights = p["weights"], expected_returns, volatilities, correlations, risk_free_rate)
        r["name"] = String(name)
        push!(rows, r)
    end
    sharpes = [r["sharpe_ratio"] === nothing ? -Inf : r["sharpe_ratio"] for r in rows]
    return Dict{String,Any}(
        "portfolios" => rows,
        "highest_return_index" => argmax([r["expected_return_percent"] for r in rows]),
        "lowest_volatility_index" => argmin([r["volatility_percent"] for r in rows]),
        "best_sharpe_index" => argmax(sharpes),
    )
end

"""
correlation_matrix(; series, labels=nothing)
`series` is a list of equally long lists of periodic returns (one list per asset, at least 3 observations).
Returns the sample correlation matrix, means and standard deviations (sample, n-1).
"""
function correlation_matrix(; series)
    (series isa AbstractVector && 2 <= length(series) <= MAX_ASSETS) || throw(InvalidInput("series must contain 2 to $MAX_ASSETS lists"))
    first_s = series[1]
    (first_s isa AbstractVector && 3 <= length(first_s) <= MAX_OBSERVATIONS) || throw(InvalidInput("each series needs 3 to $MAX_OBSERVATIONS observations"))
    T = length(first_s)
    M = zeros(T, length(series))
    for (j, s) in enumerate(series)
        (s isa AbstractVector && length(s) == T) || throw(InvalidInput("all series must have the same length"))
        for i in 1:T
            M[i, j] = check_range(s[i], "series value", -1.0e6, 1.0e6)
        end
    end
    sds = vec(std(M; dims = 1))
    all(>(0), sds) || throw(InvalidInput("a series with no variation has no correlation"))
    C = cor(M)
    C = (C + C') / 2
    for i in axes(C, 1)
        C[i, i] = 1.0
    end
    return Dict{String,Any}("correlation" => [collect(C[i, :]) for i in axes(C, 1)],
                            "means" => vec(mean(M; dims = 1)), "standard_deviations" => sds,
                            "observations" => T, "assets" => length(series))
end
