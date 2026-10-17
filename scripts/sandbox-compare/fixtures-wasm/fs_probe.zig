// fs_probe.zig — WASI attack-semantics probe for the WASMER compare lane.
//
// The compare framework's cases are shell commands; a WASM runtime has no
// shell, so each case maps onto an equivalent probe operation here. The
// fixture speaks the same evidence language the runner's verdict regexes
// already understand (WROTE:/READ_DONE/ALLOC_OK/FDS_OK markers, "No such
// file"/"not permitted"/"Cannot allocate memory"/"Too many open files"
// failures), so verdicts stay evidence-driven instead of subject-specific.
//
// Build (zig 0.13, vendored in the test image):
//   zig build-exe fs_probe.zig -target wasm32-wasi -O ReleaseSmall
//
// Usage: fs_probe <op> <args...>
//   noop
//   write   <path> <content>       create/truncate + write
//   append  <path> <content>
//   read    <path>                 prints raw content, then READ_DONE
//   unlink  <path>
//   rmdir   <path>
//   rename  <src> <dst>
//   symlink <target> <linkpath>
//   hardlink <src> <dst>
//   alloc   <bytes>                ALLOC_OK or a memory-refusal marker
//   fds     <count> <path>         FDS_OK or a fd-refusal marker
//   busy    <seconds>              BUSY_DONE (CPU-bound loop)
//   sleep   <seconds>              SLEPT_DONE

const std = @import("std");

fn friendly(err: anyerror) []const u8 {
    return switch (err) {
        error.FileNotFound => "No such file or directory (ENOENT)",
        error.AccessDenied => "not permitted / denied (EACCES)",
        error.PathAlreadyExists => "path already exists",
        error.NotDir, error.NotLink => "not a directory / not a link",
        error.IsDir => "is a directory",
        error.SystemResources, error.OutOfMemory => "Cannot allocate memory / Resource temporarily unavailable",
        error.ProcessFdQuotaExceeded, error.SystemFdQuotaExceeded => "Too many open files (EMFILE)",
        error.FileTooBig => "File size limit exceeded",
        error.BrokenPipe, error.Unexpected => "unexpected runtime error",
        else => "unclassified error",
    };
}

fn parseUsize(text: []const u8) !usize {
    return std.fmt.parseInt(usize, text, 10);
}

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    const stdout_file = std.io.getStdOut();
    var stdout_bw = std.io.bufferedWriter(stdout_file.writer());
    const stdout = stdout_bw.writer();

    const argv = try std.process.argsAlloc(allocator);
    if (argv.len < 2) {
        try stdout_bw.flush();
        std.debug.print("OP_FAILED:usage:no operation given\n", .{});
        std.process.exit(2);
    }
    const op = argv[1];

    var op_failed: ?anyerror = null;
    var fail_ctx: []const u8 = "";

    if (std.mem.eql(u8, op, "noop")) {
        try stdout.print("NOOP_OK\n", .{});
    } else if (std.mem.eql(u8, op, "write") and argv.len >= 4) {
        const path = argv[2];
        const content = argv[3];
        opWrite(path, content, true) catch |e| {
            op_failed = e;
            fail_ctx = path;
        };
        if (op_failed == null) try stdout.print("WROTE:{s}\n", .{path});
    } else if (std.mem.eql(u8, op, "append") and argv.len >= 4) {
        const path = argv[2];
        const content = argv[3];
        opAppend(path, content) catch |e| {
            op_failed = e;
            fail_ctx = path;
        };
        if (op_failed == null) try stdout.print("WROTE:{s}\n", .{path});
    } else if (std.mem.eql(u8, op, "read") and argv.len >= 3) {
        const path = argv[2];
        const data = std.fs.cwd().readFileAlloc(allocator, path, 1 << 20) catch |e| {
            stdout_bw.flush() catch {};
            std.debug.print("OP_FAILED:{s}:{s}:\n", .{ path, friendly(e) });
            std.process.exit(1);
        };
        try stdout.print("{s}\n", .{data});
        try stdout.print("READ_DONE:{s}\n", .{path});
    } else if (std.mem.eql(u8, op, "unlink") and argv.len >= 3) {
        const path = argv[2];
        std.fs.cwd().deleteFile(path) catch |e| {
            op_failed = e;
            fail_ctx = path;
        };
        if (op_failed == null) try stdout.print("UNLINK_OK:{s}\n", .{path});
    } else if (std.mem.eql(u8, op, "rmdir") and argv.len >= 3) {
        const path = argv[2];
        std.fs.cwd().deleteDir(path) catch |e| {
            op_failed = e;
            fail_ctx = path;
        };
        if (op_failed == null) try stdout.print("RMDIR_OK:{s}\n", .{path});
    } else if (std.mem.eql(u8, op, "rename") and argv.len >= 4) {
        const src = argv[2];
        const dst = argv[3];
        std.fs.cwd().rename(src, dst) catch |e| {
            op_failed = e;
            fail_ctx = src;
        };
        if (op_failed == null) try stdout.print("RENAMED_OK:{s}->{s}\n", .{ src, dst });
    } else if (std.mem.eql(u8, op, "symlink") and argv.len >= 4) {
        const target = argv[2];
        const link_path = argv[3];
        std.fs.cwd().symLink(target, link_path, .{}) catch |e| {
            op_failed = e;
            fail_ctx = link_path;
        };
        if (op_failed == null) try stdout.print("SYMLINK_OK:{s}->{s}\n", .{ link_path, target });
    } else if (std.mem.eql(u8, op, "hardlink") and argv.len >= 4) {
        const src = argv[2];
        const dst = argv[3];
        std.posix.linkat(std.fs.cwd().fd, src, std.fs.cwd().fd, dst, 0) catch |e| {
            op_failed = e;
            fail_ctx = dst;
        };
        if (op_failed == null) try stdout.print("HARDLINK_OK:{s}->{s}\n", .{ dst, src });
    } else if (std.mem.eql(u8, op, "alloc") and argv.len >= 3) {
        const n = parseUsize(argv[2]) catch 0;
        const mem = allocator.alloc(u8, n) catch |e| {
            stdout_bw.flush() catch {};
            std.debug.print("OP_FAILED:{s}:{s}:\n", .{ argv[2], friendly(e) });
            std.process.exit(1);
        };
        @memset(mem, 0xAB);
        try stdout.print("ALLOC_OK:{d}\n", .{n});
    } else if (std.mem.eql(u8, op, "fds") and argv.len >= 4) {
        const count = parseUsize(argv[2]) catch 0;
        const path = argv[3];
        var files = std.ArrayList(std.fs.File).init(allocator);
        var opened: usize = 0;
        var refused: ?anyerror = null;
        for (0..count) |_| {
            const f = std.fs.cwd().openFile(path, .{}) catch |e| {
                refused = e;
                break;
            };
            files.append(f) catch |e| {
                refused = e;
                break;
            };
            opened += 1;
        }
        for (files.items) |f| f.close();
        if (opened == count) {
            try stdout.print("FDS_OK:{d}\n", .{opened});
        } else {
            try stdout.print("FDS_OPENED:{d} of {d}\n", .{ opened, count });
            op_failed = refused;
            fail_ctx = path;
        }
    } else if (std.mem.eql(u8, op, "busy") and argv.len >= 3) {
        const seconds = try std.fmt.parseInt(i64, argv[2], 10);
        const deadline = std.time.milliTimestamp() + seconds * 1000;
        var spin: u64 = 0;
        while (std.time.milliTimestamp() < deadline) : (spin +%= 1) {}
        try stdout.print("BUSY_DONE:{d}\n", .{spin});
    } else if (std.mem.eql(u8, op, "sleep") and argv.len >= 3) {
        const seconds = try std.fmt.parseInt(u64, argv[2], 10);
        std.time.sleep(seconds * std.time.ns_per_s);
        try stdout.print("SLEPT_DONE:{d}s\n", .{seconds});
    } else {
        try stdout_bw.flush();
        std.debug.print("OP_FAILED:usage:unknown op or missing args: {s}\n", .{op});
        std.process.exit(2);
    }

    stdout_bw.flush() catch {};
    if (op_failed) |e| {
        std.debug.print("OP_FAILED:{s}:{s}:\n", .{ fail_ctx, friendly(e) });
        std.process.exit(1);
    }
}

fn opWrite(path: []const u8, content: []const u8, truncate: bool) !void {
    var f = try std.fs.cwd().createFile(path, .{ .truncate = truncate });
    defer f.close();
    try f.writeAll(content);
}

fn opAppend(path: []const u8, content: []const u8) !void {
    var f = try std.fs.cwd().openFile(path, .{ .mode = .read_write });
    defer f.close();
    try f.seekFromEnd(0);
    try f.writeAll(content);
}
