# Usage:  echo '{"fn":"sip_monte_carlo","args":{...}}' | julia --project=julia-engine -t auto julia-engine/bin/run.jl
# Reads ONE JSON request from stdin, prints ONE JSON answer. Only approved functions can be called.
using RupeyantraEngine
println(RupeyantraEngine.handle_request(read(stdin, String)))
