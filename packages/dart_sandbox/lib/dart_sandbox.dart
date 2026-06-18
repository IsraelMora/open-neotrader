/// NeuroTrader Sandbox — executes Python plugins via dart:io subprocess.
///
/// Not available on Flutter Web (dart:io is unavailable there).
/// Use [SandboxRunner] to call the Python runner.py process.
library dart_sandbox;

export 'src/models/plugin_info.dart';
export 'src/models/sandbox_result.dart';
export 'src/sandbox_runner.dart';
