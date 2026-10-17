#!/usr/bin/env bash
# WASMER lane smoke check (run inside hourglass-test: docker run -i ... bash < this)
set +e
echo "== fixture:"
ls -la /opt/hourglass-wasm/
mkdir -p /root/vtest; echo hello > /root/vtest/f.txt
echo "== read via volume:"
wasmer run /opt/hourglass-wasm/fs_probe.wasm --volume /root/vtest:/workspace -- read /workspace/f.txt
echo "rc=$?"
echo "== write via volume:"
wasmer run /opt/hourglass-wasm/fs_probe.wasm --volume /root/vtest:/workspace -- write /workspace/new.txt WORLD
echo "rc=$?"
cat /root/vtest/new.txt
echo "== unmapped path:"
wasmer run /opt/hourglass-wasm/fs_probe.wasm --volume /root/vtest:/workspace -- write /outside/escape.txt X
echo "rc=$?"
echo "== broken volume (ROB-01 analog):"
wasmer run /opt/hourglass-wasm/fs_probe.wasm --volume /root/does-not-exist:/workspace -- write /workspace/x.txt Y
echo "rc=$?"
echo "== traversal (FS-05 analog):"
wasmer run /opt/hourglass-wasm/fs_probe.wasm --volume /root/vtest:/workspace -- write /workspace/../trav.txt T
echo "rc=$?"
ls /root/trav.txt /trav.txt 2>&1 | head -2
