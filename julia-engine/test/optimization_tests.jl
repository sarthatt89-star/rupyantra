# Phase C tests. Reference numbers come from independent scipy/numpy calculations (SLSQP and closed forms), not from this engine.

const MU3 = [12, 8, 6]
const SD3 = [20, 12, 5]
const O3 = (expected_returns = MU3, volatilities = SD3, correlations = C3)

@testset "optimize: minimum variance" begin
    a = optimize_portfolio(expected_returns = [10, 10], volatilities = [20, 10])          # uncorrelated
    @test a["weights"] ≈ [0.2, 0.8] atol = 1e-6
    @test a["volatility_percent"] ≈ 8.944271909999161 rtol = 1e-6
    @test a["correlations_assumed_zero"] == true

    b = optimize_portfolio(expected_returns = [10, 10], volatilities = [20, 10], correlations = [[1, 0.8], [0.8, 1]])
    @test b["weights"] ≈ [0.0, 1.0] atol = 1e-6                                        # long-only: the riskier asset gets 0
    @test b["volatility_percent"] ≈ 10.0 rtol = 1e-6

    c = optimize_portfolio(; O3...)
    @test c["weights"] ≈ [0.02259887378973722, 0.07796609973788769, 0.899435026472375] atol = 1e-5
    @test c["volatility_percent"] ≈ 4.862865166454715 rtol = 1e-5
    @test c["expected_return_percent"] ≈ 6.291525442214198 rtol = 1e-5
    @test sum(c["weights"]) ≈ 1.0 atol = 1e-12
    @test all(c["weights"] .>= 0)

    d = optimize_portfolio(; O3..., min_weight = 0.1, max_weight = 0.5)                   # weight limits
    @test d["weights"] ≈ [0.1, 0.4, 0.5] atol = 1e-6
    @test d["volatility_percent"] ≈ 6.697014260101287 rtol = 1e-6
end

@testset "optimize: maximum Sharpe ratio" begin
    a = optimize_portfolio(; O3..., objective = "max_sharpe", risk_free_rate = 5)
    @test a["sharpe_ratio"] ≈ 0.4067591199363279 rtol = 1e-5
    @test a["weights"] ≈ [0.27086612711653474, 0.2020997335675449, 0.5270341393159205] atol = 2e-3
    @test a["expected_return_percent"] ≈ 8.0293962298343 atol = 0.01
    # never worse than the simple alternatives
    mv = optimize_portfolio(; O3..., risk_free_rate = 5)
    @test a["sharpe_ratio"] >= mv["sharpe_ratio"] - 1e-9

    b = optimize_portfolio(; O3..., objective = "max_sharpe", risk_free_rate = 5, max_weight = 0.4)
    @test all(b["weights"] .<= 0.4 + 1e-9)
    @test b["sharpe_ratio"] ≈ 0.40347329239296437 rtol = 1e-5
    @test b["weights"] ≈ [0.325, 0.275, 0.4] atol = 3e-3

    @test_throws InvalidInput optimize_portfolio(; O3..., objective = "max_sharpe", risk_free_rate = 20)   # nothing beats the risk-free rate
end

@testset "optimize: target return" begin
    a = optimize_portfolio(; O3..., objective = "target_return", target_return = 9)
    @test a["expected_return_percent"] ≈ 9.0 atol = 1e-3
    @test a["weights"] ≈ [0.40952381234546836, 0.27142856296359463, 0.319047624690937] atol = 2e-3
    @test a["volatility_percent"] ≈ 10.046676778204535 rtol = 1e-3
    # a target below the minimum-variance return is already met by the minimum-variance portfolio
    low = optimize_portfolio(; O3..., objective = "target_return", target_return = 5)
    @test low["volatility_percent"] ≈ 4.862865166454715 rtol = 1e-5
    # more return costs more risk
    hi = optimize_portfolio(; O3..., objective = "target_return", target_return = 11)
    @test hi["volatility_percent"] > a["volatility_percent"]
    @test hi["expected_return_percent"] ≈ 11.0 atol = 1e-3
    @test_throws InvalidInput optimize_portfolio(; O3..., objective = "target_return", target_return = 13)    # above the best asset
    @test_throws InvalidInput optimize_portfolio(; O3..., objective = "target_return")                        # target missing
end

@testset "optimize: invalid inputs" begin
    @test_throws InvalidInput optimize_portfolio(; O3..., objective = "make_money")
    @test_throws InvalidInput optimize_portfolio(; O3..., max_weight = 0.3)          # 3 x 0.3 cannot reach 1
    @test_throws InvalidInput optimize_portfolio(; O3..., min_weight = 0.4)          # 3 x 0.4 is more than 1
    @test_throws InvalidInput optimize_portfolio(; O3..., min_weight = 0.6, max_weight = 0.2)
    @test_throws InvalidInput optimize_portfolio(expected_returns = [10], volatilities = [10])
    @test_throws InvalidInput optimize_portfolio(expected_returns = fill(8, 25), volatilities = fill(10, 25))
    @test_throws InvalidInput optimize_portfolio(expected_returns = [10, 8], volatilities = [0, 0])
    @test_throws InvalidInput optimize_portfolio(expected_returns = [10, 8], volatilities = [10, 12], correlations = [[1, 0.5], [0.4, 1]])
end

@testset "efficient frontier" begin
    f = efficient_frontier(; O3..., points = 12)
    rows = f["frontier"]
    @test length(rows) >= 3
    @test f["points"] == length(rows)
    vols = [r["volatility_percent"] for r in rows]
    rets = [r["expected_return_percent"] for r in rows]
    @test issorted(vols)
    @test issorted(rets)                                        # more risk, more return along the efficient frontier
    @test vols[1] ≈ 4.862865166454715 rtol = 1e-4              # starts at the minimum-variance portfolio
    @test rets[end] ≈ 12.0 atol = 0.05                         # ends at the highest-return asset
    @test all(sum(r["weights"]) ≈ 1.0 for r in rows)
    @test all(v >= vols[1] - 1e-6 for v in vols)
    @test_throws InvalidInput efficient_frontier(; O3..., points = 2)
end

@testset "goal plan" begin
    a = goal_plan(goal_amount = 1.0e7, years = 15, annual_return = 12)
    @test a["required_monthly_sip_at_expected_return"] ≈ 19818.62000906072 rtol = 1e-9
    @test a["months"] == 180
    @test a["total_invested_at_that_sip"] ≈ 19818.62000906072 * 180 rtol = 1e-9

    b = goal_plan(goal_amount = 1.0e7, years = 15, annual_return = 12, current_savings = 200000)
    @test b["required_monthly_sip_at_expected_return"] ≈ 17442.049589077527 rtol = 1e-9

    z = goal_plan(goal_amount = 1.0e6, years = 5, annual_return = 0)
    @test z["required_monthly_sip_at_expected_return"] ≈ 1.0e6 / 60 rtol = 1e-12

    s = goal_plan(goal_amount = 1.0e5, years = 5, annual_return = 8, current_savings = 1.0e6)
    @test s["required_monthly_sip_at_expected_return"] == 0.0
    @test s["savings_alone_reach_goal"] == true

    i = goal_plan(goal_amount = 1.0e7, years = 20, annual_return = 10, inflation = 6, goal_in_todays_money = true)
    @test i["goal_amount_nominal"] ≈ 32071354.72212848 rtol = 1e-9
    @test i["required_monthly_sip_at_expected_return"] ≈ 41885.18239927382 rtol = 1e-9

    # with zero volatility the probability-based answer equals the closed form
    v0 = goal_plan(goal_amount = 1.0e7, years = 15, annual_return = 12, annual_volatility = 0, simulations = 200)
    @test v0["required_monthly_sip_for_target_probability"] ≈ 19818.62000906072 rtol = 1e-6
end

@testset "goal plan with market uncertainty" begin
    p = goal_plan(goal_amount = 1.0e7, years = 15, annual_return = 12, annual_volatility = 15, target_probability = 80,
                  simulations = 20000, seed = 11)
    need = p["required_monthly_sip_for_target_probability"]
    @test need > p["required_monthly_sip_at_expected_return"]            # being 80% sure needs more than the average-case plan
    @test 20 < p["chance_of_reaching_goal_with_expected_return_sip_percent"] < 70
    # cross-check with the Monte Carlo of Phase A: same seed and market model
    at = sip_monte_carlo(monthly_amount = need, annual_return = 12, annual_volatility = 15, months = 180, simulations = 20000, seed = 11, goal_amount = 1.0e7)
    @test at["goal_probability_percent"] >= 80 - 0.05
    below = sip_monte_carlo(monthly_amount = need * 0.97, annual_return = 12, annual_volatility = 15, months = 180, simulations = 20000, seed = 11, goal_amount = 1.0e7)
    @test below["goal_probability_percent"] < 80
    # a higher confidence level costs more
    p90 = goal_plan(goal_amount = 1.0e7, years = 15, annual_return = 12, annual_volatility = 15, target_probability = 90, simulations = 20000, seed = 11)
    @test p90["required_monthly_sip_for_target_probability"] > need
    # existing savings lower the monthly need
    withL = goal_plan(goal_amount = 1.0e7, years = 15, annual_return = 12, annual_volatility = 15, current_savings = 500000, simulations = 20000, seed = 11)
    @test withL["required_monthly_sip_for_target_probability"] < need
    # same input, same answer
    @test p == goal_plan(goal_amount = 1.0e7, years = 15, annual_return = 12, annual_volatility = 15, target_probability = 80, simulations = 20000, seed = 11)

    @test_throws InvalidInput goal_plan(goal_amount = 1.0e7, years = 0, annual_return = 12)
    @test_throws InvalidInput goal_plan(goal_amount = NaN, years = 5, annual_return = 12)
    @test_throws InvalidInput goal_plan(goal_amount = 1.0e7, years = 5, annual_return = 12, inflation = 50)
    @test_throws InvalidInput goal_plan(goal_amount = 1.0e7, years = 5, annual_return = 12, annual_volatility = 15, target_probability = 30)
    @test_throws InvalidInput goal_plan(goal_amount = 1.0e7, years = 5, annual_return = 12, goal_in_todays_money = "yes")
end

@testset "goal sensitivity" begin
    t = goal_sensitivity(goal_amount = 5.0e6, returns = [8, 10, 12], years_list = [10, 15, 20])
    @test length(t["rows"]) == 3
    @test t["rows"][1]["required_monthly_sip"] ≈ [27149.4674, 24206.977, 21520.2715] rtol = 1e-7
    @test t["rows"][2]["required_monthly_sip"] ≈ [14353.5803, 11963.8901, 9909.31] rtol = 1e-7
    @test t["rows"][3]["required_monthly_sip"] ≈ [8432.4538, 6529.9989, 5004.264] rtol = 1e-7
    @test all(issorted(r["required_monthly_sip"]; rev = true) for r in t["rows"])      # higher return -> smaller SIP
    @test issorted([r["required_monthly_sip"][1] for r in t["rows"]]; rev = true)      # longer time -> smaller SIP
    @test_throws InvalidInput goal_sensitivity(goal_amount = 5.0e6, returns = collect(1:11), years_list = [10])
    @test_throws InvalidInput goal_sensitivity(goal_amount = 5.0e6, returns = [8], years_list = [0])
end

@testset "optimization JSON entry point" begin
    a = req("optimize_portfolio", Dict("expected_returns" => [10, 10], "volatilities" => [20, 10]))
    @test a["ok"] == true && a["engine"] == "julia"
    @test a["result"]["weights"] ≈ [0.2, 0.8] atol = 1e-6
    b = req("goal_plan", Dict("goal_amount" => 1.0e7, "years" => 15, "annual_return" => 12))
    @test b["ok"] == true
    @test b["result"]["required_monthly_sip_at_expected_return"] ≈ 19818.62000906072 rtol = 1e-9
    c = req("optimize_portfolio", Dict("expected_returns" => [10, 10], "volatilities" => [20, 10], "objective" => "run_shell"))
    @test c["ok"] == false && c["code"] == "INVALID_INPUT"
    d = req("efficient_frontier", Dict("expected_returns" => MU3, "volatilities" => SD3, "correlations" => C3, "points" => 6))
    @test d["ok"] == true && d["result"]["points"] >= 3
end

@testset "optimization at a realistic size (timing printed)" begin
    n = 15
    mu = [6 + 0.7 * i for i in 1:n]
    sd = [8 + 1.1 * i for i in 1:n]
    C = [i == j ? 1.0 : 0.3 for i in 1:n, j in 1:n]
    rows = [collect(C[i, :]) for i in 1:n]
    t = @elapsed r = optimize_portfolio(expected_returns = mu, volatilities = sd, correlations = rows, objective = "max_sharpe", risk_free_rate = 5)
    println("Julia max-Sharpe optimisation, 15 assets: ", round(t * 1000; digits = 1), " ms")
    @test sum(r["weights"]) ≈ 1.0 atol = 1e-9
    mv = optimize_portfolio(expected_returns = mu, volatilities = sd, correlations = rows, risk_free_rate = 5)
    eqw = portfolio_analysis(weights = fill(1 / n, n), expected_returns = mu, volatilities = sd, correlations = rows, risk_free_rate = 5)
    @test r["sharpe_ratio"] >= mv["sharpe_ratio"] - 1e-9
    @test r["sharpe_ratio"] >= eqw["sharpe_ratio"] - 1e-9
    @test mv["volatility_percent"] <= eqw["volatility_percent"] + 1e-9
    @test t < 60
end
