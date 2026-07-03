def allocate_adb_port(used_ports: set[int], start: int, end: int) -> int:
    for port in range(start, end + 1):
        if port not in used_ports:
            return port
    raise RuntimeError(f"no free ADB port in range {start}-{end}")
