from lib_latency import format_latency_line, summarize_latencies


def test_summarize_latencies_empty():
    s = summarize_latencies([])
    assert s["n"] == 0
    assert s["mean_ms"] == 0.0
    assert s["p50_ms"] == 0.0


def test_summarize_latencies_single_value():
    s = summarize_latencies([0.1])
    assert s["n"] == 1
    assert s["mean_ms"] == 100.0
    assert s["p50_ms"] == s["p95_ms"] == s["p99_ms"] == 100.0
    assert s["min_ms"] == s["max_ms"] == 100.0


def test_summarize_latencies_known_distribution():
    # 1..100 ms in seconds; nearest-rank interpolated percentiles.
    vals = [i / 1000.0 for i in range(1, 101)]
    s = summarize_latencies(vals)
    assert s["n"] == 100
    assert s["mean_ms"] == 50.5
    assert s["min_ms"] == 1.0
    assert s["max_ms"] == 100.0
    # p50 of 1..100 (nearest-rank interpolation) sits around 50-51
    assert 49.0 <= s["p50_ms"] <= 51.0
    assert s["p95_ms"] > s["p50_ms"]
    assert s["p99_ms"] > s["p95_ms"]
    assert s["p99_ms"] <= s["max_ms"]


def test_summarize_latencies_order_independent():
    a = summarize_latencies([0.3, 0.1, 0.2])
    b = summarize_latencies([0.1, 0.2, 0.3])
    assert a == b


def test_format_latency_line_empty():
    assert "n/a" in format_latency_line(summarize_latencies([]))


def test_format_latency_line_nonempty():
    line = format_latency_line(summarize_latencies([0.01, 0.02]))
    assert "mean=" in line and "p95=" in line and "n=2" in line
