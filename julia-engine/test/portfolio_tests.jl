# Phase B tests. Reference numbers come from an independent numpy calculation (not from this engine).
# 3 assets: weights .5/.3/.2, returns 12/8/6 %, volatilities 20/12/5 %, correlations below.

const C3 = [[1, 0.3, 0.1], [0.3, 1, 0.2], [0.1, 0.2, 1]]
const P3 = (weights = [0.5, 0.3, 0.2], expected_returns = [12, 8, 6], volatilities = [20, 12, 5], correlations = C3)

@testset "portfolio analysis: known answers" begin
    r = portfolio_analysis(; P3...)
    @test r["expected_return_percent"] ≈ 9.6 rtol = 1e-12
    @test r["volatility_percent"] ≈ 11.789826122551595 rtol = 1e-10
    @test r["risk_contribution_percent"] ≈ [80.43165467625899, 17.611510791366904, 1.956834532374101] rtol = 1e-9
    @test sum(r["risk_contribution_percent"]) ≈ 100 rtol = 1e-12
    @test r["weighted_average_volatility_percent"] ≈ 14.6 rtol = 1e-12
    @test r["diversification_ratio"] ≈ 1.2383558373327577 rtol = 1e-10
    @test r["diversification_benefit_percent"] ≈ 19.247766283893185 rtol = 1e-9
    @test r["effective_number_of_assets"] ≈ 2.6315789473684212 rtol = 1e-12
    @test r["largest_weight"] == 0.5
    @test r["correlations_assumed_zero"] == false
    s = portfolio_analysis(; P3..., risk_free_rate = 5)
    @test s["sharpe_ratio"] ≈ 0.3901669076527866 rtol = 1e-10
end

@testset "portfolio analysis: limiting cases" begin
    two(c) = portfolio_analysis(weights = [0.5, 0.5], expected_returns = [10, 10], volatilities = [20, 10], correlations = [[1, c], [c, 1]])
    @test two(1)["volatility_percent"] ≈ 15.0 rtol = 1e-12          # perfect correlation: no diversification
    @test two(1)["diversification_benefit_percent"] ≈ 0.0 atol = 1e-9
    @test two(0)["volatility_percent"] ≈ 11.180339887498949 rtol = 1e-12
    @test two(-1)["volatility_percent"] ≈ 5.0 rtol = 1e-12
    @test two(0.5)["volatility_percent"] ≈ 13.228756555322954 rtol = 1e-12

    one = portfolio_analysis(weights = [1.0], expected_returns = [9], volatilities = [18])
    @test one["volatility_percent"] ≈ 18.0 rtol = 1e-12
    @test one["effective_number_of_assets"] ≈ 1.0
    @test one["correlations_assumed_zero"] == true                 # reported, never hidden

    eq = portfolio_analysis(weights = fill(0.25, 4), expected_returns = [8, 9, 10, 11], volatilities = [15, 15, 15, 15])
    @test eq["effective_number_of_assets"] ≈ 4.0 rtol = 1e-12
    @test eq["volatility_percent"] ≈ 7.5 rtol = 1e-12             # 4 uncorrelated equal assets: 15 / sqrt(4)

    z = portfolio_analysis(weights = [0.5, 0.5], expected_returns = [5, 5], volatilities = [0, 0])
    @test z["volatility_percent"] == 0.0
    @test z["sharpe_ratio"] === nothing && z["risk_contribution_percent"] === nothing
end

@testset "portfolio analysis: invalid inputs" begin
    base = (weights = [0.5, 0.5], expected_returns = [10, 12], volatilities = [15, 20])
    @test_throws InvalidInput portfolio_analysis(; base..., weights = [0.6, 0.6])        # does not add up to 1
    @test_throws InvalidInput portfolio_analysis(; base..., weights = [1.5, -0.5])       # short selling not supported
    @test_throws InvalidInput portfolio_analysis(; base..., expected_returns = [10])     # wrong length
    @test_throws InvalidInput portfolio_analysis(; base..., volatilities = [15, -1])
    @test_throws InvalidInput portfolio_analysis(; base..., correlations = [[1, 0.5], [0.4, 1]])   # not symmetric
    @test_throws InvalidInput portfolio_analysis(; base..., correlations = [[1, 2], [2, 1]])       # outside [-1, 1]
    @test_throws InvalidInput portfolio_analysis(; base..., correlations = [[2, 0], [0, 1]])       # diagonal not 1
    # 3 assets with impossible pairwise correlations (not positive semi-definite)
    @test_throws InvalidInput portfolio_analysis(weights = [1 / 3, 1 / 3, 1 / 3], expected_returns = [1, 2, 3], volatilities = [10, 10, 10],
                                                 correlations = [[1, 0.9, -0.9], [0.9, 1, 0.9], [-0.9, 0.9, 1]])
    @test_throws InvalidInput portfolio_analysis(; base..., weights = [])
    @test_throws InvalidInput portfolio_analysis(; base..., expected_returns = [NaN, 1])
    @test_throws InvalidInput portfolio_analysis(weights = fill(1 / 60, 60), expected_returns = fill(8, 60), volatilities = fill(10, 60))
end

@testset "portfolio compare" begin
    ports = [Dict("name" => "Aggressive", "weights" => [0.8, 0.1, 0.1]),
             Dict("name" => "Balanced", "weights" => [0.5, 0.3, 0.2]),
             Dict("name" => "Safe", "weights" => [0.1, 0.2, 0.7])]
    c = portfolio_compare(; portfolios = ports, expected_returns = [12, 8, 6], volatilities = [20, 12, 5], correlations = C3, risk_free_rate = 5)
    @test length(c["portfolios"]) == 3
    @test c["highest_return_index"] == 1
    @test c["lowest_volatility_index"] == 3
    @test c["portfolios"][2]["name"] == "Balanced"
    @test c["portfolios"][2]["expected_return_percent"] ≈ 9.6 rtol = 1e-12
    @test 1 <= c["best_sharpe_index"] <= 3
    @test_throws InvalidInput portfolio_compare(; portfolios = ports[1:1], expected_returns = [12, 8, 6], volatilities = [20, 12, 5])
    @test_throws InvalidInput portfolio_compare(; portfolios = [Dict("weights" => [1.0])], expected_returns = [1], volatilities = [1])
end

@testset "correlation matrix from return series" begin
    r = correlation_matrix(series = [[1, 2, 3, 4, 5], [2, 1, 4, 3, 6], [5, 4, 3, 2, 1]])
    @test r["correlation"][1][2] ≈ 0.8219949365267863 rtol = 1e-10
    @test r["correlation"][1][3] ≈ -1.0 rtol = 1e-12
    @test r["correlation"][2][3] ≈ -0.8219949365267863 rtol = 1e-10
    @test all(r["correlation"][i][i] == 1.0 for i in 1:3)
    @test r["means"] ≈ [3.0, 3.2, 3.0]
    @test r["standard_deviations"] ≈ [1.5811388300841898, 1.9235384061671346, 1.5811388300841898] rtol = 1e-12
    @test r["observations"] == 5 && r["assets"] == 3
    @test_throws InvalidInput correlation_matrix(series = [[1, 2, 3], [1, 2]])           # different lengths
    @test_throws InvalidInput correlation_matrix(series = [[1, 2, 3], [4, 4, 4]])        # no variation
    @test_throws InvalidInput correlation_matrix(series = [[1, 2]])                      # too few series
    @test_throws InvalidInput correlation_matrix(series = [[1, 2], [3, 4]])              # too few observations
end

@testset "portfolio JSON entry point" begin
    a = req("portfolio_analysis", Dict("weights" => [0.5, 0.3, 0.2], "expected_returns" => [12, 8, 6], "volatilities" => [20, 12, 5], "correlations" => C3))
    @test a["ok"] == true && a["engine"] == "julia"
    @test a["result"]["volatility_percent"] ≈ 11.789826122551595 rtol = 1e-10
    b = req("portfolio_analysis", Dict("weights" => [0.9, 0.9], "expected_returns" => [1, 2], "volatilities" => [3, 4]))
    @test b["ok"] == false && b["code"] == "INVALID_INPUT"
    c = req("correlation_matrix", Dict("series" => [[1, 2, 3, 4, 5], [2, 1, 4, 3, 6]]))
    @test c["ok"] == true
    @test c["result"]["correlation"][1][2] ≈ 0.8219949365267863 rtol = 1e-10
end
