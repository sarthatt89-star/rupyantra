# Portfolio optimisation and goal-based planning.
# Everything here is a model on the numbers you supply. Optimised weights are very sensitive to the input estimates,
# so the output is a planning calculation, not investment advice and not a guaranteed result.
#
# Method: long-only weights that add up to 1 with a minimum/maximum per asset. The convex problem
#   minimise  w'Sw - gamma * mu'w
# is solved with accelerated projected gradient (FISTA) on the box-simplex; every special objective is built from it:
#   gamma = 0              -> minimum variance
#   gamma bisected         -> minimum variance for a target return
#   gamma scanned          -> efficient frontier and maximum Sharpe ratio (grid scan, then local refinement)

const MAX_OPT_ASSETS = 20
const OBJECTIVES = ("min_variance", "max_sharpe", "target_return")

_rows(C) = [collect(C[i, :]) for i in 1:size(C, 1)]

# ---- projection onto { w : sum(w) = 1, lo <= w_i <= hi } ----
function _project(v::Vector{Float64}, lo::Float64, hi::Float64)
    a = minimum(v) - hi          # at this shift every weight is clamped to hi  (sum >= 1)
    b = maximum(v) - lo          # at this shift every weight is clamped to lo  (sum <= 1)
    w = similar(v)
    for _ in 1:100
        m = (a + b) / 2
        s = 0.0
        for i in eachindex(v)
            s += clamp(v[i] - m, lo, hi)
        end
        if s > 1
            a = m
        else
            b = m
        end
        b - a < 1e-15 && break
    end
    m = (a + b) / 2
    for i in eachindex(v)
        w[i] = clamp(v[i] - m, lo, hi)
    end
    return w
end

# minimise w'Sw - gamma*mu'w on the box-simplex; returns weights (warm start w0 optional)
function _solve(S::Matrix{Float64}, mu::Vector{Float64}, gamma::Float64, lo::Float64, hi::Float64, w0::Vector{Float64})
    L = 2 * eigmax(Symmetric(S))
    t = 1 / L
    w = _project(copy(w0), lo, hi)
    y = copy(w)
    tk = 1.0
    for _ in 1:5000
        g = 2 .* (S * y) .- gamma .* mu
        wn = _project(y .- t .* g, lo, hi)
        tn = (1 + sqrt(1 + 4 * tk^2)) / 2
        y = wn .+ ((tk - 1) / tn) .* (wn .- w)
        done = maximum(abs.(wn .- w)) < 1e-13
        w = wn
        tk = tn
        done && break
    end
    return w
end

# most return that the constraints allow (fill the best assets up to hi, the rest at lo)
function _max_return(mu::Vector{Float64}, lo::Float64, hi::Float64)
    n = length(mu)
    left = 1 - n * lo
    r = lo * sum(mu)
    for i in sortperm(mu; rev = true)
        add = min(hi - lo, left)
        r += add * mu[i]
        left -= add
        left <= 0 && break
    end
    return r
end

function _setup(expected_returns, volatilities, correlations, min_weight, max_weight)
    (expected_returns isa AbstractVector && 2 <= length(expected_returns) <= MAX_OPT_ASSETS) ||
        throw(InvalidInput("expected_returns must list 2 to $MAX_OPT_ASSETS assets"))
    n = length(expected_returns)
    mu = _numbers(expected_returns, "expected_returns", -50, 100; n = n) ./ 100
    sd = _numbers(volatilities, "volatilities", 0, 100; n = n) ./ 100
    maximum(sd) > 0 || throw(InvalidInput("at least one asset needs a volatility above 0"))
    C, assumed = _correlations(correlations, n)
    lo = check_range(min_weight, "min_weight", 0, 1)
    hi = check_range(max_weight, "max_weight", 0, 1)
    lo <= hi || throw(InvalidInput("min_weight cannot be above max_weight"))
    (n * lo <= 1 + 1e-9 && n * hi >= 1 - 1e-9) || throw(InvalidInput("the weight limits cannot add up to 1 for $n assets"))
    S = (sd * sd') .* C
    S = (S + S') / 2
    return n, mu, sd, S, C, assumed, lo, hi
end

function _gamma_scale(S, mu)
    return 2 * sum(diag(S)) / length(mu) / max(maximum(abs.(mu)), 1e-9)
end

function _optimal_weights(objective, S, mu, rf, lo, hi, target)
    n = length(mu)
    w0 = fill(1 / n, n)
    wmin = _solve(S, mu, 0.0, lo, hi, w0)
    if objective == "min_variance"
        return wmin, 0.0
    elseif objective == "target_return"
        sum(wmin .* mu) >= target && return wmin, 0.0
        target <= _max_return(mu, lo, hi) + 1e-12 || throw(InvalidInput("target_return is higher than these assets and limits can give"))
        glo, ghi = 0.0, _gamma_scale(S, mu)
        w = _solve(S, mu, ghi, lo, hi, wmin)
        while sum(w .* mu) < target && ghi < 1e15
            glo = ghi
            ghi *= 4
            w = _solve(S, mu, ghi, lo, hi, w)
        end
        best = w
        for _ in 1:60
            gm = (glo + ghi) / 2
            wm = _solve(S, mu, gm, lo, hi, best)
            if sum(wm .* mu) >= target
                ghi = gm
                best = wm
            else
                glo = gm
            end
        end
        sum(best .* mu) >= target - 1e-9 || throw(InvalidInput("target_return could not be reached with these limits"))
        return best, ghi
    else  # max_sharpe
        maximum(mu) > rf || throw(InvalidInput("no asset has an expected return above the risk-free rate"))
        sharpe(w) = (v = sqrt(max(w' * S * w, 0.0)); v > 0 ? (sum(w .* mu) - rf) / v : -Inf)
        g0 = _gamma_scale(S, mu)
        # Sharpe is flat (a plateau) at both ends of the gamma range, so a plain ternary search can get lost there.
        # Scan a fine grid first, then refine around the best grid point, where the curve is a single hill.
        grid = [g0 * 10.0^e for e in range(-4, 4; length = 161)]
        best_w, best_s, best_g, best_k = wmin, sharpe(wmin), 0.0, 0
        w = wmin
        for (k, g) in enumerate(grid)
            w = _solve(S, mu, g, lo, hi, w)
            s = sharpe(w)
            if s > best_s
                best_w, best_s, best_g, best_k = w, s, g, k
            end
        end
        if best_k > 0
            a = log(grid[max(best_k - 1, 1)])
            b = log(grid[min(best_k + 1, length(grid))])
            w = best_w
            for _ in 1:60
                m1 = a + (b - a) / 3
                m2 = b - (b - a) / 3
                w1 = _solve(S, mu, exp(m1), lo, hi, w)
                w2 = _solve(S, mu, exp(m2), lo, hi, w)
                s1, s2 = sharpe(w1), sharpe(w2)
                if s1 < s2
                    a = m1
                else
                    b = m2
                end
                cw, cs, cg = s1 >= s2 ? (w1, s1, exp(m1)) : (w2, s2, exp(m2))
                if cs > best_s
                    best_w, best_s, best_g = cw, cs, cg
                end
                w = best_w
            end
        end
        return best_w, best_g
    end
end

"""
optimize_portfolio(; expected_returns, volatilities, correlations=nothing, objective="min_variance",
                   risk_free_rate=0, target_return=nothing, min_weight=0, max_weight=1)
objective: "min_variance" | "max_sharpe" | "target_return" (needs target_return in percent).
"""
function optimize_portfolio(; expected_returns, volatilities, correlations = nothing, objective = "min_variance",
                            risk_free_rate = 0, target_return = nothing, min_weight = 0, max_weight = 1)
    (objective isa AbstractString && objective in OBJECTIVES) || throw(InvalidInput("objective must be one of: " * join(OBJECTIVES, ", ")))
    n, mu, sd, S, C, assumed, lo, hi = _setup(expected_returns, volatilities, correlations, min_weight, max_weight)
    rf = check_range(risk_free_rate, "risk_free_rate", -10, 50) / 100
    target = 0.0
    if objective == "target_return"
        target_return === nothing && throw(InvalidInput("target_return is required for this objective"))
        target = check_range(target_return, "target_return", -50, 100) / 100
    end
    w, gamma = _optimal_weights(objective, S, mu, rf, lo, hi, target)
    w = [x < 1e-12 ? 0.0 : x for x in w]
    w = clamp.(w ./ sum(w), 0.0, 1.0)
    analysis = portfolio_analysis(; weights = w, expected_returns = mu .* 100, volatilities = sd .* 100,
                                  correlations = assumed ? nothing : _rows(C), risk_free_rate = rf * 100)
    analysis["objective"] = objective
    analysis["weights"] = w
    analysis["min_weight"] = lo
    analysis["max_weight"] = hi
    analysis["risk_aversion_tradeoff"] = gamma
    analysis["note"] = "Planning calculation on your inputs; small changes in expected returns can change the weights a lot. Not investment advice."
    return analysis
end

"""
efficient_frontier(; expected_returns, volatilities, correlations=nothing, points=15, min_weight=0, max_weight=1, risk_free_rate=0)
A set of efficient portfolios from minimum variance towards the highest-return one (distinct portfolios only).
"""
function efficient_frontier(; expected_returns, volatilities, correlations = nothing, points = 15,
                            min_weight = 0, max_weight = 1, risk_free_rate = 0)
    pts = check_int(points, "points", 3, 25)
    n, mu, sd, S, C, assumed, lo, hi = _setup(expected_returns, volatilities, correlations, min_weight, max_weight)
    rf = check_range(risk_free_rate, "risk_free_rate", -10, 50)
    g0 = _gamma_scale(S, mu)
    gammas = vcat(0.0, [g0 * 10.0^e for e in range(-3, 4; length = pts - 1)])
    rows = Dict{String,Any}[]
    seen = Set{Vector{Float64}}()
    w = fill(1 / n, n)
    for g in gammas
        w = _solve(S, mu, g, lo, hi, w)
        key = round.(w; digits = 6)
        key in seen && continue
        push!(seen, key)
        wc = [x < 1e-12 ? 0.0 : x for x in w]
        wc = clamp.(wc ./ sum(wc), 0.0, 1.0)
        a = portfolio_analysis(; weights = wc, expected_returns = mu .* 100, volatilities = sd .* 100,
                               correlations = assumed ? nothing : _rows(C), risk_free_rate = rf)
        a["weights"] = wc
        push!(rows, a)
    end
    sort!(rows; by = r -> r["volatility_percent"])
    return Dict{String,Any}("frontier" => rows, "points" => length(rows),
                            "correlations_assumed_zero" => assumed)
end

# ---------------- goal-based planning ----------------

function _required_sip(goal::Float64, savings::Float64, ret::Float64, n::Int)
    r = ret / 1200
    growth = (1 + r)^n
    annuity = abs(r) < 1e-12 ? Float64(n) : (growth - 1) / r * (1 + r)
    return max((goal - savings * growth) / annuity, 0.0)
end

# per-path growth factors with unit monthly amount: a = value of 1/month SIP, b = growth of 1 invested at start
function _paths(ret::Float64, vol::Float64, m::Int, sims::Int, seed::Int)
    g = 1 + ret / 1200
    sig = vol / 100 / sqrt(12)
    mu = log(g) - 0.5 * sig^2
    a = Vector{Float64}(undef, sims)
    b = Vector{Float64}(undef, sims)
    nchunks = cld(sims, CHUNK)
    Threads.@threads for c in 1:nchunks
        rng = Random.Xoshiro(UInt64(seed) * 1_000_003 + UInt64(c))
        for i in ((c - 1) * CHUNK + 1):min(c * CHUNK, sims)
            x = 0.0
            y = 1.0
            for _ in 1:m
                z = exp(mu + sig * randn(rng))
                x = (x + 1) * z
                y *= z
            end
            a[i] = x
            b[i] = y
        end
    end
    return a, b
end

_prob(a, b, P, L, goal) = 100 * count(i -> P * a[i] + L * b[i] >= goal, eachindex(a)) / length(a)

"""
goal_plan(; goal_amount, years, annual_return, current_savings=0, inflation=0, goal_in_todays_money=false,
          annual_volatility=nothing, target_probability=80, simulations=10000, seed=12345)
Monthly SIP needed to reach a goal: (1) at the expected return, (2) optionally the amount that reaches the goal with the
requested probability under the simulated market model.
"""
function goal_plan(; goal_amount, years, annual_return, current_savings = 0, inflation = 0, goal_in_todays_money = false,
                   annual_volatility = nothing, target_probability = 80, simulations = 10_000, seed = DEFAULT_SEED)
    G = check_range(goal_amount, "goal_amount", 0.01, LIMITS.max_amount)
    y = check_range(years, "years", 0.1, 100)
    n = round(Int, y * 12)
    (1 <= n <= LIMITS.max_months) || throw(InvalidInput("years is out of range"))
    ret = check_range(annual_return, "annual_return", -50, 100)
    L = check_range(current_savings, "current_savings", 0, LIMITS.max_amount)
    infl = check_range(inflation, "inflation", 0, 30)
    goal_in_todays_money isa Bool || throw(InvalidInput("goal_in_todays_money must be true or false"))
    nominal = goal_in_todays_money ? G * (1 + infl / 100)^(n / 12) : G

    P = _required_sip(nominal, L, ret, n)
    growth = (1 + ret / 1200)^n
    out = Dict{String,Any}(
        "goal_amount_entered" => G,
        "goal_amount_nominal" => nominal,
        "months" => n,
        "annual_return_assumed" => ret,
        "current_savings" => L,
        "savings_alone_reach_goal" => L * growth >= nominal,
        "required_monthly_sip_at_expected_return" => P,
        "total_invested_at_that_sip" => P * n + L,
        "note" => "Planning estimate under the assumed return; real returns vary and are not guaranteed.",
    )
    if annual_volatility !== nothing
        vol = check_range(annual_volatility, "annual_volatility", 0, 100)
        tp = check_range(target_probability, "target_probability", 50, 99.9)
        _, _, _, s, sd = _common(ret, vol, n, simulations, seed)
        a, b = _paths(ret, vol, n, s, sd)
        chance_det = _prob(a, b, P, L, nominal)
        needed = if _prob(a, b, 0.0, L, nominal) >= tp
            0.0
        else
            lo, hi = 0.0, nominal / minimum(a)
            for _ in 1:80
                mid = (lo + hi) / 2
                if _prob(a, b, mid, L, nominal) >= tp
                    hi = mid
                else
                    lo = mid
                end
            end
            hi
        end
        out["annual_volatility_assumed"] = vol
        out["simulations"] = s
        out["chance_of_reaching_goal_with_expected_return_sip_percent"] = chance_det
        out["target_probability_percent"] = tp
        out["required_monthly_sip_for_target_probability"] = needed
        out["total_invested_at_probability_sip"] = needed * n + L
    end
    return out
end

"""
goal_sensitivity(; goal_amount, returns, years_list, current_savings=0)
Table of the monthly SIP needed at each expected return and each duration (at most 10 x 10).
"""
function goal_sensitivity(; goal_amount, returns, years_list, current_savings = 0)
    G = check_range(goal_amount, "goal_amount", 0.01, LIMITS.max_amount)
    L = check_range(current_savings, "current_savings", 0, LIMITS.max_amount)
    rs = _numbers(returns, "returns", -50, 100)
    ys = _numbers(years_list, "years_list", 0.1, 100)
    (length(rs) <= 10 && length(ys) <= 10) || throw(InvalidInput("at most 10 returns and 10 durations"))
    rows = Dict{String,Any}[]
    for y in ys
        n = round(Int, y * 12)
        (1 <= n <= LIMITS.max_months) || throw(InvalidInput("years_list is out of range"))
        push!(rows, Dict{String,Any}("years" => y, "months" => n,
                                     "required_monthly_sip" => [_required_sip(G, L, r, n) for r in rs]))
    end
    return Dict{String,Any}("returns" => rs, "rows" => rows, "goal_amount" => G, "current_savings" => L,
                            "note" => "Each cell is the monthly SIP needed if the stated return were earned every year; not a prediction.")
end
