# Monte Carlo simulation of SIP and lumpsum investments.
#
# Model (same idea as the C++ engine): every month the balance is multiplied by a random log-normal factor whose
# EXPECTED value equals the expected monthly growth `g`:  factor = exp(mu + sigma*Z),  mu = ln(g) - sigma^2/2.
# With volatility 0 the result is exactly the closed-form compound growth.
# These are estimates under assumptions, never guaranteed returns.

const DEFAULT_SEED = 12345
const CHUNK = 1000   # simulations per independent random stream: results do not depend on the number of threads

"Closed-form SIP future value (investment at the START of each month), the deterministic reference."
function sip_future_value(monthly::Real, annual_return::Real, months::Integer)
    r = annual_return / 1200
    bal = 0.0
    for _ in 1:months
        bal = (bal + monthly) * (1 + r)
    end
    return bal
end

function _summary(finals::Vector{Float64}, invested::Float64, goal)
    sort!(finals)
    n = length(finals)
    out = Dict{String,Any}(
        "invested" => invested,
        "p10" => percentile(finals, 10),
        "p25" => percentile(finals, 25),
        "p50" => percentile(finals, 50),
        "p75" => percentile(finals, 75),
        "p90" => percentile(finals, 90),
        "mean" => stable_sum(finals) / n,
        "min" => finals[1],
        "max" => finals[end],
        "prob_loss_percent" => 100 * count(<(invested), finals) / n,
        "simulations" => n,
    )
    if goal !== nothing
        out["goal_amount"] = goal
        out["goal_probability_percent"] = 100 * count(>=(goal), finals) / n
    end
    return out
end

# runs `path(rng)` for every simulation; each chunk of CHUNK simulations has its own seeded generator
function _run(path::Function, sims::Int, seed::Int)
    finals = Vector{Float64}(undef, sims)
    nchunks = cld(sims, CHUNK)
    Threads.@threads for c in 1:nchunks
        rng = Random.Xoshiro(UInt64(seed) * 1_000_003 + UInt64(c))
        for i in ((c - 1) * CHUNK + 1):min(c * CHUNK, sims)
            finals[i] = path(rng)
        end
    end
    return finals
end

function _check_work(sims::Int, months::Int)
    sims * months <= LIMITS.max_work || throw(InvalidInput("simulations x months is too large (max $(LIMITS.max_work))"))
end

function _common(annual_return, annual_volatility, months, sims, seed)
    ret = check_range(annual_return, "annual_return", -50, 100)
    vol = check_range(annual_volatility, "annual_volatility", 0, 100)
    m = check_int(months, "months", 1, LIMITS.max_months)
    s = check_int(sims, "simulations", LIMITS.min_sims, LIMITS.max_sims)
    sd = check_int(seed, "seed", 0, 2^31 - 1)
    _check_work(s, m)
    return ret, vol, m, s, sd
end

"""
sip_monte_carlo(; monthly_amount, annual_return, annual_volatility, months, simulations=10000, seed=12345, goal_amount=nothing)
Returns a Dict with percentiles (p10..p90), mean, min, max, probability of loss and (optionally) goal probability.
"""
function sip_monte_carlo(; monthly_amount, annual_return, annual_volatility, months,
                         simulations = 10_000, seed = DEFAULT_SEED, goal_amount = nothing)
    P = check_range(monthly_amount, "monthly_amount", 0.01, LIMITS.max_amount)
    ret, vol, m, s, sd = _common(annual_return, annual_volatility, months, simulations, seed)
    goal = goal_amount === nothing ? nothing : check_range(goal_amount, "goal_amount", 0.01, LIMITS.max_amount)

    g = 1 + ret / 1200
    sig = vol / 100 / sqrt(12)
    mu = log(g) - 0.5 * sig^2
    path = rng -> begin
        bal = 0.0
        for _ in 1:m
            bal = (bal + P) * exp(mu + sig * randn(rng))
        end
        bal
    end
    res = _summary(_run(path, s, sd), P * m, goal)
    res["months"] = m
    res["seed"] = sd
    res["deterministic_reference"] = sip_future_value(P, ret, m)
    return res
end

"""
lumpsum_monte_carlo(; principal, annual_return, annual_volatility, months, compounds_per_year=1, simulations=10000, seed=12345, goal_amount=nothing)
"""
function lumpsum_monte_carlo(; principal, annual_return, annual_volatility, months, compounds_per_year = 1,
                             simulations = 10_000, seed = DEFAULT_SEED, goal_amount = nothing)
    P = check_range(principal, "principal", 0.01, LIMITS.max_amount)
    ret, vol, m, s, sd = _common(annual_return, annual_volatility, months, simulations, seed)
    cpy = check_int(compounds_per_year, "compounds_per_year", 1, 365)
    goal = goal_amount === nothing ? nothing : check_range(goal_amount, "goal_amount", 0.01, LIMITS.max_amount)

    g = (1 + ret / 100 / cpy)^(cpy / 12)     # expected growth per month
    sig = vol / 100 / sqrt(12)
    mu = log(g) - 0.5 * sig^2
    path = rng -> begin
        bal = P
        for _ in 1:m
            bal *= exp(mu + sig * randn(rng))
        end
        bal
    end
    res = _summary(_run(path, s, sd), P, goal)
    res["months"] = m
    res["seed"] = sd
    res["deterministic_reference"] = P * g^m
    return res
end

"""
sip_scenarios(; monthly_amount, months, returns::Vector, annual_volatility, ...) runs the same SIP for several expected returns
(same seed for each, so the comparison is fair) and reports the differences against the first scenario.
"""
function sip_scenarios(; monthly_amount, months, returns, annual_volatility,
                       simulations = 10_000, seed = DEFAULT_SEED, goal_amount = nothing)
    (returns isa AbstractVector && 2 <= length(returns) <= LIMITS.max_scenarios) ||
        throw(InvalidInput("returns must be a list of 2 to $(LIMITS.max_scenarios) numbers"))
    results = [sip_monte_carlo(; monthly_amount, annual_return = r, annual_volatility, months, simulations, seed, goal_amount)
               for r in returns]
    base = results[1]["p50"]
    rows = [Dict{String,Any}("annual_return" => Float64(returns[i]), "result" => results[i],
                             "median_difference_vs_first" => results[i]["p50"] - base) for i in eachindex(results)]
    return Dict{String,Any}("scenarios" => rows, "best_median_index" => argmax([r["p50"] for r in results]))
end
