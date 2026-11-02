# Phase D: numerical self-checks, small matrix operations and market stress scenarios.
# Stress shocks and multipliers are numbers YOU supply; the engine does not invent market history or forecasts.

const MAX_MATRIX = 20
const MAX_STRESS_SCENARIOS = 10
const MATRIX_OPS = ("multiply", "transpose", "determinant", "inverse", "solve", "eigenvalues", "trace")

function _matrix(x, name::AbstractString)
    (x isa AbstractVector && !isempty(x) && length(x) <= MAX_MATRIX) || throw(InvalidInput("$name must be a list of 1 to $MAX_MATRIX rows"))
    first_row = x[1]
    (first_row isa AbstractVector && !isempty(first_row) && length(first_row) <= MAX_MATRIX) ||
        throw(InvalidInput("$name must be a list of rows (each row a list of numbers)"))
    m, n = length(x), length(first_row)
    M = zeros(m, n)
    for i in 1:m
        row = x[i]
        (row isa AbstractVector && length(row) == n) || throw(InvalidInput("$name rows must all have the same length"))
        for j in 1:n
            M[i, j] = check_range(row[j], name, -1.0e6, 1.0e6)
        end
    end
    return M
end

"""
matrix_operations(; operation, a, b=nothing)
operation: multiply (a*b) | transpose | determinant | inverse | solve (a*x = b, b a list) | eigenvalues (symmetric a) | trace.
Matrices are lists of rows, at most 20 x 20. Singular or badly conditioned matrices are refused, not guessed.
"""
function matrix_operations(; operation, a, b = nothing)
    (operation isa AbstractString && operation in MATRIX_OPS) || throw(InvalidInput("operation must be one of: " * join(MATRIX_OPS, ", ")))
    A = _matrix(a, "a")
    square() = size(A, 1) == size(A, 2) || throw(InvalidInput("this operation needs a square matrix"))
    out = Dict{String,Any}("operation" => operation, "rows" => size(A, 1), "columns" => size(A, 2))
    if operation == "transpose"
        out["result"] = _rows(permutedims(A))
    elseif operation == "multiply"
        b === nothing && throw(InvalidInput("b is required for multiply"))
        B = _matrix(b, "b")
        size(A, 2) == size(B, 1) || throw(InvalidInput("columns of a must equal rows of b"))
        out["result"] = _rows(A * B)
    elseif operation == "trace"
        square()
        out["result"] = sum(diag(A))
    elseif operation == "determinant"
        square()
        out["result"] = det(A)
    elseif operation == "inverse"
        square()
        c = cond(A)
        (isfinite(c) && c < 1e12) || throw(InvalidInput("matrix is singular or too badly conditioned to invert"))
        Ai = inv(A)
        out["result"] = _rows(Ai)
        out["condition_number"] = c
        out["max_residual"] = maximum(abs.(A * Ai - I))     # how close A*inverse is to the identity
    elseif operation == "solve"
        square()
        (b isa AbstractVector && length(b) == size(A, 1)) || throw(InvalidInput("b must be a list with one number per row of a"))
        bv = Float64[check_range(v, "b", -1.0e6, 1.0e6) for v in b]
        c = cond(A)
        (isfinite(c) && c < 1e12) || throw(InvalidInput("matrix is singular or too badly conditioned to solve"))
        x = A \ bv
        out["result"] = x
        out["condition_number"] = c
        out["max_residual"] = maximum(abs.(A * x - bv))
    else  # eigenvalues
        square()
        all(abs(A[i, j] - A[j, i]) <= 1e-9 * max(1.0, abs(A[i, j])) for i in 1:size(A, 1), j in 1:size(A, 1)) ||
            throw(InvalidInput("eigenvalues are supported for symmetric matrices only"))
        out["result"] = sort(eigvals(Symmetric(A)))
    end
    return out
end

"""
numerical_checks(; monthly_amount, annual_return, months)
Self-check: the SIP future value computed three independent ways (closed formula, month-by-month, compensated sum of every
instalment's growth). They must agree; the differences are reported so the numerical accuracy is visible.
"""
function numerical_checks(; monthly_amount, annual_return, months)
    P = check_range(monthly_amount, "monthly_amount", 0, LIMITS.max_amount)
    ret = check_range(annual_return, "annual_return", -50, 100)
    n = check_int(months, "months", 1, LIMITS.max_months)
    r = ret / 1200
    closed = abs(r) < 1e-12 ? P * n : P * ((1 + r)^n - 1) / r * (1 + r)
    stepwise = sip_future_value(P, ret, n)
    summed = stable_sum([P * (1 + r)^k for k in 1:n])      # instalment j grows for n-j+1 months
    scale = max(abs(closed), 1.0)
    d1 = abs(closed - stepwise) / scale
    d2 = abs(closed - summed) / scale
    return Dict{String,Any}(
        "closed_form" => closed, "month_by_month" => stepwise, "compensated_sum" => summed,
        "relative_difference_stepwise" => d1, "relative_difference_sum" => d2,
        "tolerance" => 1e-9, "agree" => max(d1, d2) <= 1e-9,
        "note" => "Three independent routes to the same SIP value; they agree when the arithmetic is numerically sound.")
end

"""
stress_scenarios(; weights, scenarios, portfolio_value=nothing)
scenarios: list of {"name": text, "shocks": [percent change per asset]} (at most 10). Weights are today's portfolio weights.
The change is the weighted sum of the shocks you supply; it is a what-if, not a forecast.
"""
function stress_scenarios(; weights, scenarios, portfolio_value = nothing)
    w = _numbers(weights, "weights", 0, 1)
    abs(sum(w) - 1) <= 1e-6 || throw(InvalidInput("weights must add up to 1"))
    (scenarios isa AbstractVector && 1 <= length(scenarios) <= MAX_STRESS_SCENARIOS) ||
        throw(InvalidInput("scenarios must list 1 to $MAX_STRESS_SCENARIOS scenarios"))
    value = portfolio_value === nothing ? nothing : check_range(portfolio_value, "portfolio_value", 0, LIMITS.max_amount)
    rows = Dict{String,Any}[]
    for (k, s) in enumerate(scenarios)
        (s isa AbstractDict && haskey(s, "shocks")) || throw(InvalidInput("each scenario needs a name and a shocks list"))
        name = get(s, "name", "scenario $k")
        (name isa AbstractString && length(name) <= 80) || throw(InvalidInput("scenario name must be short text"))
        shocks = _numbers(s["shocks"], "shocks", -100, 1000; n = length(w))
        contrib = w .* shocks
        change = sum(contrib)
        row = Dict{String,Any}("name" => name, "portfolio_change_percent" => change,
                               "contribution_percent" => contrib, "worst_asset_index" => argmin(shocks))
        if value !== nothing
            row["change_amount"] = value * change / 100
            row["value_after"] = value * (1 + change / 100)
        end
        push!(rows, row)
    end
    worst = argmin([r["portfolio_change_percent"] for r in rows])
    return Dict{String,Any}("scenarios" => rows, "worst_scenario" => rows[worst]["name"],
                            "worst_change_percent" => rows[worst]["portfolio_change_percent"],
                            "note" => "What-if arithmetic on the shocks you entered; not a prediction of any market move.")
end

"""
volatility_stress(; weights, volatilities, correlations=nothing, volatility_multiplier=1, correlation_blend=0)
Portfolio volatility when every asset's volatility is multiplied and correlations move towards 1
(correlation_blend 0 = as entered, 1 = all assets move together; diversification disappears in a crisis).
"""
function volatility_stress(; weights, volatilities, correlations = nothing, volatility_multiplier = 1, correlation_blend = 0)
    w = _numbers(weights, "weights", 0, 1)
    abs(sum(w) - 1) <= 1e-6 || throw(InvalidInput("weights must add up to 1"))
    n = length(w)
    sd = _numbers(volatilities, "volatilities", 0, 100; n = n)
    C, assumed = _correlations(correlations, n)
    m = check_range(volatility_multiplier, "volatility_multiplier", 0.1, 10)
    b = check_range(correlation_blend, "correlation_blend", 0, 1)
    sd2 = sd .* m
    C2 = (1 - b) .* C .+ b .* ones(n, n)
    for i in 1:n
        C2[i, i] = 1.0
    end
    vol_of(s, M) = sqrt(max(w' * ((s * s') .* M) * w, 0.0))
    base = vol_of(sd, C)
    stressed = vol_of(sd2, C2)
    return Dict{String,Any}("base_volatility_percent" => base, "stressed_volatility_percent" => stressed,
                            "increase_percent" => base > 0 ? 100 * (stressed / base - 1) : nothing,
                            "volatility_multiplier" => m, "correlation_blend" => b,
                            "correlations_assumed_zero" => assumed,
                            "note" => "Illustrative stress on the inputs you gave; not a forecast.")
end
