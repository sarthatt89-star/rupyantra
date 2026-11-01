# The ONLY door into the engine from outside (JSON in, JSON out). Nothing here evaluates user text as code.

const APPROVED = Dict{String,NamedTuple}(
    "sip_monte_carlo" => (
        fn = sip_monte_carlo,
        required = (:monthly_amount, :annual_return, :annual_volatility, :months),
        optional = (:simulations, :seed, :goal_amount),
    ),
    "lumpsum_monte_carlo" => (
        fn = lumpsum_monte_carlo,
        required = (:principal, :annual_return, :annual_volatility, :months),
        optional = (:compounds_per_year, :simulations, :seed, :goal_amount),
    ),
    "sip_scenarios" => (
        fn = sip_scenarios,
        required = (:monthly_amount, :months, :returns, :annual_volatility),
        optional = (:simulations, :seed, :goal_amount),
    ),
    "portfolio_analysis" => (
        fn = portfolio_analysis,
        required = (:weights, :expected_returns, :volatilities),
        optional = (:correlations, :risk_free_rate),
    ),
    "portfolio_compare" => (
        fn = portfolio_compare,
        required = (:portfolios, :expected_returns, :volatilities),
        optional = (:correlations, :risk_free_rate),
    ),
    "correlation_matrix" => (
        fn = correlation_matrix,
        required = (:series,),
        optional = (),
    ),
)

const MAX_REQUEST_BYTES = 200_000

"""
handle_request(json_text) -> JSON text. Always returns {"ok":true,"engine":"julia",...} or {"ok":false,"code":...,"error":...}.
`engine`/`julia_version` in the answer are evidence that Julia really ran this calculation.
"""
function handle_request(json_text::AbstractString)
    t0 = time_ns()
    fail(code, msg) = JSON.json(Dict("ok" => false, "engine" => "julia", "code" => code, "error" => msg))
    try
        sizeof(json_text) <= MAX_REQUEST_BYTES || return fail("TOO_LARGE", "request is too large")
        req = JSON.parse(json_text)
        (req isa AbstractDict && haskey(req, "fn") && req["fn"] isa AbstractString) || return fail("BAD_REQUEST", "fn missing")
        spec = get(APPROVED, req["fn"], nothing)
        spec === nothing && return fail("NOT_APPROVED", "function is not approved")
        args = get(req, "args", Dict())
        args isa AbstractDict || return fail("BAD_REQUEST", "args must be an object")

        allowed = Set(string.((spec.required..., spec.optional...)))
        for k in keys(args)
            k in allowed || return fail("BAD_REQUEST", "unknown argument: $(first(k, 40))")
        end
        for k in spec.required
            haskey(args, string(k)) || return fail("BAD_REQUEST", "missing argument: $k")
        end
        kw = (; (Symbol(k) => v for (k, v) in args)...)
        result = spec.fn(; kw...)
        ms = (time_ns() - t0) / 1e6
        return JSON.json(Dict("ok" => true, "engine" => "julia", "julia_version" => string(VERSION),
                              "fn" => req["fn"], "threads" => Threads.nthreads(), "elapsed_ms" => ms, "result" => result))
    catch e
        e isa InvalidInput && return fail("INVALID_INPUT", e.msg)
        return fail("INTERNAL_ERROR", "calculation failed")   # details are not leaked to the caller
    end
end
