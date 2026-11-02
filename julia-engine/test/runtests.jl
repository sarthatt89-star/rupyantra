using Test
using JSON
using RupeyantraEngine
using RupeyantraEngine: InvalidInput, percentile, stable_sum, check_range, check_int

# Reference values were computed independently (plain Python loops), not with this engine:
#   SIP 10000/month, 12%, 120 months  -> 2323390.763519404
#   Lumpsum 100000, 12%, 5y, yearly   -> 176234.16832
#   Lumpsum 100000, 12%, 5y, quarterly-> 180611.12346694068
const SIP_REF = 2323390.763519404
req(fn, args) = JSON.parse(handle_request(JSON.json(Dict("fn" => fn, "args" => args))))

@testset "runtime" begin
    @test VERSION >= v"1.9"
    println("Julia ", VERSION, " threads=", Threads.nthreads())
end

@testset "numerical helpers" begin
    @test percentile([1.0, 2, 3, 4, 5], 50) == 3.0
    @test percentile([1.0, 2, 3, 4, 5], 0) == 1.0
    @test percentile([1.0, 2, 3, 4, 5], 100) == 5.0
    @test percentile([10.0, 20.0], 25) ≈ 12.5
    @test percentile([7.0], 90) == 7.0
    @test_throws InvalidInput percentile(Float64[], 50)
    # compensated sum stays accurate over a million additions
    @test stable_sum(fill(0.1, 1_000_000)) ≈ 100_000.0 rtol = 1e-14
    @test stable_sum(Float64[]) == 0.0
    @test_throws InvalidInput check_range(NaN, "x", 0, 1)
    @test_throws InvalidInput check_range(true, "x", 0, 1)
    @test_throws InvalidInput check_int(1.5, "x", 0, 10)
end

@testset "SIP closed form" begin
    @test sip_future_value(10000, 12, 120) ≈ SIP_REF rtol = 1e-12
    @test sip_future_value(5000, 0, 60) ≈ 300000.0
    @test sip_future_value(10000, -6, 24) ≈ 225559.5141023973 rtol = 1e-12
end

@testset "SIP Monte Carlo" begin
    # zero volatility: every path is identical to the closed form
    z = sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 0, months = 120, simulations = 500)
    @test z["p10"] ≈ SIP_REF rtol = 1e-9
    @test z["p50"] ≈ SIP_REF rtol = 1e-9
    @test z["p90"] ≈ SIP_REF rtol = 1e-9
    @test z["invested"] == 1_200_000.0
    @test z["prob_loss_percent"] == 0.0

    a = sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 15, months = 120, simulations = 20000, seed = 7)
    b = sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 15, months = 120, simulations = 20000, seed = 7)
    c = sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 15, months = 120, simulations = 20000, seed = 8)
    @test a == b                      # same seed -> identical output
    @test a["p50"] != c["p50"]        # different seed -> different paths
    @test a["min"] <= a["p10"] <= a["p25"] <= a["p50"] <= a["p75"] <= a["p90"] <= a["max"]
    @test a["p50"] < a["mean"]        # log-normal: median below mean
    @test a["mean"] ≈ SIP_REF rtol = 0.02   # E[final] equals the deterministic value
    @test 0 <= a["prob_loss_percent"] <= 100
    @test a["simulations"] == 20000

    # more volatility -> wider spread
    lo = sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 5, months = 120, simulations = 5000)
    hi = sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 30, months = 120, simulations = 5000)
    @test (hi["p90"] - hi["p10"]) > (lo["p90"] - lo["p10"])

    # a falling market with no volatility always loses
    neg = sip_monte_carlo(monthly_amount = 10000, annual_return = -6, annual_volatility = 0, months = 24, simulations = 200)
    @test neg["prob_loss_percent"] == 100.0
    @test neg["p50"] ≈ 225559.5141023973 rtol = 1e-9
end

@testset "goal probability" begin
    below = sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 0, months = 120, simulations = 200, goal_amount = 2_000_000)
    above = sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 0, months = 120, simulations = 200, goal_amount = 3_000_000)
    @test below["goal_probability_percent"] == 100.0
    @test above["goal_probability_percent"] == 0.0
    mid = sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 15, months = 120, simulations = 20000, goal_amount = SIP_REF)
    @test 30 < mid["goal_probability_percent"] < 70   # goal near the median -> roughly even odds
end

@testset "lumpsum Monte Carlo" begin
    y = lumpsum_monte_carlo(principal = 100000, annual_return = 12, annual_volatility = 0, months = 60, simulations = 200)
    @test y["p50"] ≈ 176234.16832 rtol = 1e-9
    q = lumpsum_monte_carlo(principal = 100000, annual_return = 12, annual_volatility = 0, months = 60, compounds_per_year = 4, simulations = 200)
    @test q["p50"] ≈ 180611.12346694068 rtol = 1e-9
    r = lumpsum_monte_carlo(principal = 100000, annual_return = 12, annual_volatility = 20, months = 60, simulations = 20000)
    @test r["mean"] ≈ 176234.16832 rtol = 0.02
    @test r["invested"] == 100000.0
end

@testset "scenarios" begin
    s = sip_scenarios(monthly_amount = 10000, months = 120, returns = [8, 12, 15], annual_volatility = 0, simulations = 200)
    @test length(s["scenarios"]) == 3
    @test s["best_median_index"] == 3
    @test s["scenarios"][1]["median_difference_vs_first"] == 0.0
    @test s["scenarios"][3]["median_difference_vs_first"] > s["scenarios"][2]["median_difference_vs_first"] > 0
    @test_throws InvalidInput sip_scenarios(monthly_amount = 1000, months = 12, returns = [10], annual_volatility = 10)
end

@testset "invalid inputs and limits" begin
    ok = (monthly_amount = 1000, annual_return = 10, annual_volatility = 10, months = 12)
    @test_throws InvalidInput sip_monte_carlo(; ok..., monthly_amount = -5)
    @test_throws InvalidInput sip_monte_carlo(; ok..., annual_return = 500)
    @test_throws InvalidInput sip_monte_carlo(; ok..., annual_volatility = -1)
    @test_throws InvalidInput sip_monte_carlo(; ok..., months = 0)
    @test_throws InvalidInput sip_monte_carlo(; ok..., months = 5000)
    @test_throws InvalidInput sip_monte_carlo(; ok..., simulations = 10)
    @test_throws InvalidInput sip_monte_carlo(; ok..., simulations = 10_000_000)
    @test_throws InvalidInput sip_monte_carlo(; ok..., months = 1200, simulations = 100_000)   # work cap
    @test_throws InvalidInput sip_monte_carlo(; ok..., monthly_amount = NaN)
    @test_throws InvalidInput sip_monte_carlo(; ok..., monthly_amount = "1000")
    @test_throws InvalidInput lumpsum_monte_carlo(principal = 1000, annual_return = 10, annual_volatility = 10, months = 12, compounds_per_year = 0)
end

@testset "JSON entry point: approved functions only" begin
    good = req("sip_monte_carlo", Dict("monthly_amount" => 10000, "annual_return" => 12, "annual_volatility" => 0, "months" => 120, "simulations" => 100))
    @test good["ok"] == true
    @test good["engine"] == "julia"                 # evidence that Julia ran it
    @test good["julia_version"] == string(VERSION)
    @test good["result"]["p50"] ≈ SIP_REF rtol = 1e-9
    @test good["elapsed_ms"] >= 0

    @test req("run_shell", Dict())["code"] == "NOT_APPROVED"
    @test req("include", Dict("path" => "/etc/passwd"))["code"] == "NOT_APPROVED"
    @test req("sip_monte_carlo", Dict("monthly_amount" => 1000))["code"] == "BAD_REQUEST"
    extra = req("sip_monte_carlo", Dict("monthly_amount" => 1000, "annual_return" => 10, "annual_volatility" => 5, "months" => 12, "eval" => "1+1"))
    @test extra["code"] == "BAD_REQUEST"
    bad = req("sip_monte_carlo", Dict("monthly_amount" => -1, "annual_return" => 10, "annual_volatility" => 5, "months" => 12))
    @test bad["ok"] == false && bad["code"] == "INVALID_INPUT"

    @test JSON.parse(handle_request("not json"))["ok"] == false
    @test JSON.parse(handle_request("[1,2,3]"))["code"] == "BAD_REQUEST"
    @test JSON.parse(handle_request("x"^300_000))["code"] == "TOO_LARGE"
    # an error never leaks internals
    @test !occursin("Stacktrace", handle_request("not json"))
end

@testset "performance report (informational)" begin
    sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 15, months = 120, simulations = 1000)  # warm-up
    for (sims, months) in ((5000, 120), (50000, 240))
        t = @elapsed sip_monte_carlo(monthly_amount = 10000, annual_return = 12, annual_volatility = 15, months = months, simulations = sims)
        println("Julia SIP Monte Carlo ", sims, " sims x ", months, " months: ", round(t * 1000; digits = 1), " ms (threads=", Threads.nthreads(), ")")
    end
    @test true
end

include("portfolio_tests.jl")
include("optimization_tests.jl")
include("scenario_tests.jl")
