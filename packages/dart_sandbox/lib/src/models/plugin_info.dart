class PluginInfo {
  final String id;
  final String name;
  final String version;
  final String type;
  final String description;
  final String author;
  final List<String> skills;
  final bool active;

  const PluginInfo({
    required this.id,
    required this.name,
    required this.version,
    required this.type,
    required this.description,
    required this.author,
    required this.skills,
    required this.active,
  });

  factory PluginInfo.fromJson(Map<String, dynamic> json) => PluginInfo(
        id: json['id'] as String,
        name: json['name'] as String,
        version: json['version'] as String,
        type: json['type'] as String,
        description: json['description'] as String? ?? '',
        author: json['author'] as String? ?? '',
        skills: (json['skills'] as List<dynamic>?)?.cast<String>() ?? [],
        active: json['active'] as bool? ?? false,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'version': version,
        'type': type,
        'description': description,
        'author': author,
        'skills': skills,
        'active': active,
      };
}
