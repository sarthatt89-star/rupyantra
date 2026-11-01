# Small, dependency-free numerical helpers.

"Validation error: the request itself is wrong (not a bug in the engine)."
struct InvalidInput <: Exception
    msg::String
end
Base.showerror(io::IO, e::InvalidInput) = print(io, e.msg)

"Hard limits that keep one request from using too much time or memory."
const LIMITS = (
    max_months = 1200,
    min_sims = 100,
    max_sims = 500_000,
    max_work = 50_000_000,      # simulations x months
    max_amount = 1.0e12,
    max_scenarios = 10,
)

"Checks a real number lies in [lo, hi]; returns it as Float64."
function check_range(x, name::AbstractString, lo::Real, hi::Real)
    (x isa Real && !(x isa Bool) && isfinite(x)) || throw(InvalidInput("$name must be a finite number"))
    (lo <= x <= hi) || throw(InvalidInput("$name must be between $lo and $hi"))
    return Float64(x)
end

"Checks an integer-valued number lies in [lo, hi]; returns Int."
function check_int(x, name::AbstractString, lo::Integer, hi::Integer)
    v = check_range(x, name, lo, hi)
    v == round(v) || throw(InvalidInput("$name must be a whole number"))
    return Int(v)
end

"""
percentile(sorted, p): linear interpolation between closest ranks; `sorted` must be sorted ascending, p in [0, 100].
"""
function percentile(sorted::AbstractVector{<:Real}, p::Real)
    n = length(sorted)
    n == 0 && throw(InvalidInput("no data"))
    n == 1 && return Float64(sorted[1])
    h = (n - 1) * (p / 100) + 1
    lo = floor(Int, h)
    hi = min(lo + 1, n)
    return Float64(sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]))
end

"Kahan-compensated sum (keeps precision for very long vectors)."
function stable_sum(v::AbstractVector{<:Real})
    s = 0.0
    c = 0.0
    for x in v
        y = x - c
        t = s + y
        c = (t - s) - y
        s = t
    end
    return s
end
