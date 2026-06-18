/// Typed result from runner.py.
sealed class SandboxResult<T> {
  const SandboxResult();
}

final class SandboxSuccess<T> extends SandboxResult<T> {
  final T value;
  const SandboxSuccess(this.value);
}

final class SandboxError<T> extends SandboxResult<T> {
  final String message;
  const SandboxError(this.message);
}

/// Raw cycle output from run_cycle command.
class CycleResult {
  final List<String> universe;
  final List<Map<String, dynamic>> signals;
  final List<Map<String, dynamic>> errors;

  const CycleResult({
    required this.universe,
    required this.signals,
    required this.errors,
  });

  factory CycleResult.fromJson(Map<String, dynamic> json) => CycleResult(
        universe: (json['universe'] as List<dynamic>).cast<String>(),
        signals: (json['signals'] as List<dynamic>)
            .cast<Map<String, dynamic>>(),
        errors: (json['errors'] as List<dynamic>)
            .cast<Map<String, dynamic>>(),
      );
}
