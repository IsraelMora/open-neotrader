import 'dart:convert';
import 'dart:io';

import 'models/plugin_info.dart';
import 'models/sandbox_result.dart';

/// Executes Python plugins by spawning `python3 runner.py` as a subprocess.
///
/// Each [call] forks a new process for isolation — the OS enforces the
/// security boundary. On Docker the container runs with `--network=none`.
///
/// NOT available on Flutter Web (dart:io is not supported there).
class SandboxRunner {
  final String pythonExecutable;
  final String runnerPath;
  final String pluginsDir;
  final Duration timeout;

  const SandboxRunner({
    this.pythonExecutable = 'python3',
    required this.runnerPath,
    required this.pluginsDir,
    this.timeout = const Duration(seconds: 60),
  });

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  Future<SandboxResult<List<PluginInfo>>> listPlugins({
    required List<String> activeIds,
  }) async {
    final res = await _call({
      'cmd': 'list_plugins',
      'active_ids': activeIds,
    });
    return res.when(
      success: (data) => SandboxSuccess(
        (data as List<dynamic>)
            .cast<Map<String, dynamic>>()
            .map(PluginInfo.fromJson)
            .toList(),
      ),
      error: SandboxError.new,
    );
  }

  Future<SandboxResult<List<Map<String, dynamic>>>> getSkills({
    required List<String> activeIds,
  }) async {
    final res = await _call({
      'cmd': 'get_skills',
      'active_ids': activeIds,
    });
    return res.when(
      success: (data) => SandboxSuccess(
        (data as List<dynamic>).cast<Map<String, dynamic>>(),
      ),
      error: SandboxError.new,
    );
  }

  Future<SandboxResult<List<String>>> getSymbols({
    required List<String> activeIds,
  }) async {
    final res = await _call({
      'cmd': 'get_symbols',
      'active_ids': activeIds,
    });
    return res.when(
      success: (data) =>
          SandboxSuccess((data as List<dynamic>).cast<String>()),
      error: SandboxError.new,
    );
  }

  Future<SandboxResult<dynamic>> callPlugin({
    required String pluginId,
    required String function,
    Map<String, dynamic> args = const {},
    Map<String, dynamic> context = const {},
  }) =>
      _call({
        'cmd': 'call_plugin',
        'plugin_id': pluginId,
        'function': function,
        'args': args,
        'context': context,
      });

  Future<SandboxResult<CycleResult>> runCycle({
    required List<String> activeIds,
    Map<String, dynamic> context = const {},
  }) async {
    final res = await _call({
      'cmd': 'run_cycle',
      'active_ids': activeIds,
      'context': context,
    });
    return res.when(
      success: (data) => SandboxSuccess(
        CycleResult.fromJson(data as Map<String, dynamic>),
      ),
      error: SandboxError.new,
    );
  }

  // -------------------------------------------------------------------------
  // Core subprocess call
  // -------------------------------------------------------------------------

  Future<SandboxResult<dynamic>> _call(Map<String, dynamic> request) async {
    Process? process;
    try {
      process = await Process.start(
        pythonExecutable,
        [runnerPath],
        environment: {
          ...Platform.environment,
          'NEUROTRADER_PLUGINS_DIR': pluginsDir,
          'PYTHONDONTWRITEBYTECODE': '1',
          'PYTHONUNBUFFERED': '1',
        },
      );

      final payload = jsonEncode(request);
      process.stdin.writeln(payload);
      await process.stdin.close();

      final stdoutFuture = process.stdout
          .transform(const Utf8Decoder())
          .join();
      final stderrFuture = process.stderr
          .transform(const Utf8Decoder())
          .join();

      final results = await Future.wait([stdoutFuture, stderrFuture])
          .timeout(timeout);

      final stdout = results[0];
      final exitCode = await process.exitCode.timeout(
        const Duration(seconds: 5),
      );

      if (stdout.trim().isEmpty) {
        return SandboxError('Python process exited ($exitCode) with no output. '
            'stderr: ${results[1]}');
      }

      final Map<String, dynamic> response =
          jsonDecode(stdout.trim()) as Map<String, dynamic>;

      if (response['ok'] == true) {
        return SandboxSuccess(response['result']);
      } else {
        return SandboxError(response['error']?.toString() ?? 'Unknown error');
      }
    } on TimeoutException {
      process?.kill();
      return const SandboxError('Python process timed out');
    } on ProcessException catch (e) {
      return SandboxError('Failed to start Python: ${e.message}');
    } catch (e) {
      return SandboxError(e.toString());
    }
  }
}

// ---------------------------------------------------------------------------
// Extension for ergonomic pattern matching
// ---------------------------------------------------------------------------

extension SandboxResultX<T> on SandboxResult<T> {
  R when<R>({
    required R Function(T value) success,
    required R Function(String message) error,
  }) =>
      switch (this) {
        SandboxSuccess<T>(:final value) => success(value),
        SandboxError<T>(:final message) => error(message),
      };

  T? get valueOrNull =>
      this is SandboxSuccess<T> ? (this as SandboxSuccess<T>).value : null;

  bool get isSuccess => this is SandboxSuccess<T>;
}
