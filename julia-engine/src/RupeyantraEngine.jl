"""
Rupeyantra Julia engine: advanced numerical modelling that sits NEXT TO the C++/WASM engine (it replaces nothing).
Only the functions listed in `APPROVED` (src/api.jl) can be called from outside; arbitrary Julia code is never run.
"""
module RupeyantraEngine

using Random
using Statistics
using JSON

include("numerical_engine.jl")
include("simulation.jl")
include("api.jl")

export sip_monte_carlo, lumpsum_monte_carlo, sip_scenarios, sip_future_value, handle_request, APPROVED, LIMITS

end # module
