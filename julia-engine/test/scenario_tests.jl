# Phase D tests. Reference numbers come from an independent numpy calculation, or are exact by hand.

@testset "matrix operations: known answers" begin
    A = [[4, 3], [6, 3]]
    @test matrix_operations(operation = "determinant", a = A)["result"] ≈ -6.0 rtol = 1e-12
    @test matrix_operations(operation = "trace", a = A)["result"] == 7.0
    inv_r = matrix_operations(operation = "inverse", a = A)
    @test inv_r["result"] ≈ [[-0.5, 0.5], [1.0, -2 / 3]] rtol = 1e-12
    @test inv_r["max_residual"] < 1e-12
    s = matrix_operations(operation = "solve", a = A, b = [10, 12])
    @test s["result"] ≈ [1.0, 2.0] rtol = 1e-12
    @test s["max_residual"] < 1e-12
    @test matrix_operations(operation = "multiply", a = [[1, 2], [3, 4]], b = [[5, 6], [7, 8]])["result"] == [[19.0, 22.0], [43.0, 50.0]]
    @test matrix_operations(operation = "transpose", a = [[1, 2, 3]])["result"] == [[1.0], [2.0], [3.0]]
    @test matrix_operations(operation = "eigenvalues", a = [[2, 1], [1, 2]])["result"] ≈ [1.0, 3.0] rtol = 1e-12
    @test matrix_operations(operation = "eigenvalues", a = [[4, 1, 0], [1, 3, 1], [0, 1, 2]])["result"] ≈
          [1.2679491924311228, 3.0, 4.732050807568877] rtol = 1e-10
end

@testset "matrix operations: bad input is refused" begin
    @test_throws InvalidInput matrix_operations(operation = "inverse", a = [[1, 2], [2, 4]])          # singular
    @test_throws InvalidInput matrix_operations(operation = "inverse", a = [[1, 2, 3]])               # not square
    @test_throws InvalidInput matrix_operations(operation = "multiply", a = [[1, 2]], b = [[1, 2]])   # shapes do not fit
    @test_throws InvalidInput matrix_operations(operation = "multiply", a = [[1, 2]])                 # b missing
    @test_throws InvalidInput matrix_operations(operation = "eigenvalues", a = [[1, 2], [3, 4]])      # not symmetric
    @test_throws InvalidInput matrix_operations(operation = "solve", a = [[1, 0], [0, 1]], b = [1])   # wrong length
    @test_throws InvalidInput matrix_operations(operation = "run_shell", a = [[1]])
    @test_throws InvalidInput matrix_operations(operation = "trace", a = [[1, 2], [3]])               # ragged
    @test_throws InvalidInput matrix_operations(operation = "trace", a = [[1, "x"], [3, 4]])
    big = [fill(1.0, 21) for _ in 1:21]
    @test_throws InvalidInput matrix_operations(operation = "trace", a = big)
end

@testset "numerical checks: three routes agree" begin
    r = numerical_checks(monthly_amount = 10000, annual_return = 12, months = 120)
    @test r["agree"] == true
    @test r["closed_form"] ≈ sip_future_value(10000, 12, 120) rtol = 1e-12
    z = numerical_checks(monthly_amount = 1000, annual_return = 0, months = 12)
    @test z["closed_form"] ≈ 12000.0 rtol = 1e-12
    @test z["agree"] == true
    neg = numerical_checks(monthly_amount = 5000, annual_return = -10, months = 240)
    @test neg["agree"] == true
    long = numerical_checks(monthly_amount = 1.0e9, annual_return = 30, months = 1200)
    @test long["agree"] == true
    @test_throws InvalidInput numerical_checks(monthly_amount = -1, annual_return = 12, months = 12)
    @test_throws InvalidInput numerical_checks(monthly_amount = 1, annual_return = 12, months = 5000)
end

@testset "stress scenarios: what-if arithmetic" begin
    sc = [Dict("name" => "equity crash", "shocks" => [-30, -10, 5]), Dict("name" => "mild", "shocks" => [-5, 0, 2])]
    r = stress_scenarios(weights = [0.5, 0.3, 0.2], scenarios = sc, portfolio_value = 1_000_000)
    a = r["scenarios"][1]
    @test a["portfolio_change_percent"] ≈ -17.0 rtol = 1e-12
    @test a["contribution_percent"] ≈ [-15.0, -3.0, 1.0] rtol = 1e-12
    @test a["change_amount"] ≈ -170000.0 rtol = 1e-12
    @test a["value_after"] ≈ 830000.0 rtol = 1e-12
    @test a["worst_asset_index"] == 1
    @test r["scenarios"][2]["portfolio_change_percent"] ≈ -2.1 rtol = 1e-12
    @test r["worst_scenario"] == "equity crash"
    @test !haskey(stress_scenarios(weights = [1.0], scenarios = [Dict("shocks" => [-10])])["scenarios"][1], "change_amount")
    @test_throws InvalidInput stress_scenarios(weights = [0.5, 0.5], scenarios = [Dict("name" => "x", "shocks" => [-10])])  # wrong count
    @test_throws InvalidInput stress_scenarios(weights = [0.5, 0.5], scenarios = [Dict("name" => "x", "shocks" => [-150, 0])])
    @test_throws InvalidInput stress_scenarios(weights = [0.6, 0.6], scenarios = [Dict("name" => "x", "shocks" => [0, 0])])
    @test_throws InvalidInput stress_scenarios(weights = [1.0], scenarios = [])
    @test_throws InvalidInput stress_scenarios(weights = [1.0], scenarios = [Dict("name" => "x")])
end

@testset "volatility stress: limiting cases" begin
    args = (weights = [0.5, 0.3, 0.2], volatilities = [20, 12, 5], correlations = C3)
    base = volatility_stress(; args...)
    @test base["base_volatility_percent"] ≈ 11.789826122551595 rtol = 1e-10
    @test base["stressed_volatility_percent"] ≈ base["base_volatility_percent"] rtol = 1e-12
    @test volatility_stress(; args..., volatility_multiplier = 2)["stressed_volatility_percent"] ≈ 23.57965224510319 rtol = 1e-10
    # everything moves together: portfolio vol is the weighted average of the (scaled) volatilities
    @test volatility_stress(; args..., volatility_multiplier = 1.5, correlation_blend = 1)["stressed_volatility_percent"] ≈ 21.9 rtol = 1e-10
    @test volatility_stress(; args..., volatility_multiplier = 1.2, correlation_blend = 0.5)["stressed_volatility_percent"] ≈ 15.923416718782436 rtol = 1e-9
    @test volatility_stress(weights = [0.5, 0.5], volatilities = [10, 10])["correlations_assumed_zero"] == true
    @test_throws InvalidInput volatility_stress(; args..., correlation_blend = 1.5)
    @test_throws InvalidInput volatility_stress(; args..., volatility_multiplier = 0)
end

@testset "scenario JSON entry point" begin
    a = req("matrix_operations", Dict("operation" => "determinant", "a" => [[4, 3], [6, 3]]))
    @test a["ok"] == true && a["engine"] == "julia"
    @test a["result"]["result"] ≈ -6.0
    b = req("stress_scenarios", Dict("weights" => [0.5, 0.3, 0.2], "scenarios" => [Dict("name" => "crash", "shocks" => [-30, -10, 5])]))
    @test b["ok"] == true
    @test b["result"]["worst_change_percent"] ≈ -17.0
    c = req("numerical_checks", Dict("monthly_amount" => 10000, "annual_return" => 12, "months" => 120))
    @test c["ok"] == true && c["result"]["agree"] == true
    d = req("volatility_stress", Dict("weights" => [0.5, 0.5], "volatilities" => [10, 20], "correlation_blend" => 1))
    @test d["ok"] == true
    @test d["result"]["stressed_volatility_percent"] ≈ 15.0 rtol = 1e-12
    e = req("matrix_operations", Dict("operation" => "inverse", "a" => [[1, 2], [2, 4]]))
    @test e["ok"] == false && e["code"] == "INVALID_INPUT"
end
