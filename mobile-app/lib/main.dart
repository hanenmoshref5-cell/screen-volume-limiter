import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

const int kScreenHttpPort = 57100;
const Duration kHttpTimeout = Duration(seconds: 3);
const Duration kScanTimeout = Duration(milliseconds: 1500);
const String kDefaultScreenIp = '192.168.1.100';
const String kPrefsIpKey = 'screen_ip';
const String kPrefsLastCapKey = 'last_sent_cap';

void main() {
  runApp(const ScreenVolumeApp());
}

class ScreenVolumeApp extends StatelessWidget {
  const ScreenVolumeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'صوت الشاشة',
      locale: const Locale('ar'),
      theme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        useMaterial3: true,
      ),
      home: const HomePage(),
    );
  }
}

enum SendStatus { idle, sending, success, failure }

class _SendResult {
  final int statusCode;
  final String body;

  _SendResult(this.statusCode, this.body);
}

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  double _value = 30;
  SendStatus _status = SendStatus.idle;
  String _message = '';
  String _screenIp = kDefaultScreenIp;
  int? _remoteCap;
  final TextEditingController _ipController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadIp();
  }

  Future<void> _loadIp() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(kPrefsIpKey);
    setState(() {
      _screenIp = saved ?? kDefaultScreenIp;
      _ipController.text = _screenIp;
    });
    _loadLastCap();
  }

  Future<void> _loadLastCap() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getInt(kPrefsLastCapKey);
    if (saved != null) {
      setState(() => _remoteCap = saved);
    }
  }

  Future<void> _saveLastCap(int value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(kPrefsLastCapKey, value);
  }

  Future<void> _saveIp(String ip) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(kPrefsIpKey, ip);
    setState(() => _screenIp = ip);
  }

  Future<void> _editIpDialog() async {
    _ipController.text = _screenIp;
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('عنوان الشاشة (IP)'),
        content: TextField(
          controller: _ipController,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(hintText: '192.168.1.100'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('إلغاء'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, _ipController.text.trim()),
            child: const Text('حفظ'),
          ),
        ],
      ),
    );
    if (result != null && result.isNotEmpty) {
      await _saveIp(result);
    }
  }

  Future<_SendResult> _postValue(String ip, int value) async {
    final client = HttpClient()..connectionTimeout = kHttpTimeout;
    try {
      final request = await client
          .postUrl(Uri.parse('http://$ip:$kScreenHttpPort/volume-cap'))
          .timeout(kHttpTimeout);
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode({'value': value}));
      final response = await request.close().timeout(kHttpTimeout);
      final body = await response.transform(utf8.decoder).join().timeout(kHttpTimeout);
      return _SendResult(response.statusCode, body);
    } finally {
      client.close(force: true);
    }
  }

  /// IPv4 addresses of this phone on private LANs, Wi-Fi interfaces first.
  Future<List<String>> _lanAddresses() async {
    final wifi = <String>[];
    final other = <String>[];
    try {
      final interfaces = await NetworkInterface.list(
        includeLoopback: false,
        type: InternetAddressType.IPv4,
      );
      for (final iface in interfaces) {
        for (final addr in iface.addresses) {
          final ip = addr.address;
          final p = ip.split('.').map(int.tryParse).toList();
          if (p.length != 4 || p.contains(null)) continue;
          final private = p[0] == 192 && p[1] == 168 ||
              p[0] == 10 ||
              p[0] == 172 && p[1]! >= 16 && p[1]! <= 31;
          if (!private) continue;
          (iface.name.startsWith('wlan') ? wifi : other).add(ip);
        }
      }
    } catch (_) {
      // no usable interface info
    }
    return wifi.isNotEmpty ? wifi : other;
  }

  Future<bool> _isScreen(HttpClient client, String ip) async {
    try {
      final req = await client
          .getUrl(Uri.parse('http://$ip:$kScreenHttpPort/ping'))
          .timeout(kScanTimeout);
      final res = await req.close().timeout(kScanTimeout);
      final body = await res.transform(utf8.decoder).join().timeout(kScanTimeout);
      if (res.statusCode != 200) return false;
      final data = jsonDecode(body);
      return data is Map && data['ok'] == true && data.containsKey('cap');
    } catch (_) {
      return false;
    }
  }

  /// Probes every host on the phone's /24 network(s) for the Shahid service.
  /// Unicast HTTP, so it works where UDP broadcast is dropped.
  Future<String?> _findScreen(List<String> ownAddresses) async {
    final prefixes = <String>{};
    for (final ip in ownAddresses) {
      prefixes.add(ip.substring(0, ip.lastIndexOf('.')));
    }
    if (prefixes.isEmpty) return null;

    final client = HttpClient()..connectionTimeout = kScanTimeout;
    final completer = Completer<String?>();
    var pending = 0;
    for (final prefix in prefixes) {
      for (var i = 1; i < 255; i++) {
        final ip = '$prefix.$i';
        if (ownAddresses.contains(ip)) continue;
        pending++;
        _isScreen(client, ip).then((found) {
          pending--;
          if (completer.isCompleted) return;
          if (found) {
            completer.complete(ip);
          } else if (pending == 0) {
            completer.complete(null);
          }
        });
      }
    }
    try {
      return await completer.future;
    } finally {
      client.close(force: true);
    }
  }

  void _fail(String message) {
    setState(() {
      _status = SendStatus.failure;
      _message = message;
    });
  }

  Future<void> _send() async {
    final value = _value.round();
    setState(() {
      _status = SendStatus.sending;
      _message = 'جاري الإرسال إلى الشاشة...';
    });

    _SendResult? result;
    try {
      result = await _postValue(_screenIp, value);
    } catch (_) {
      result = null;
    }

    if (result == null) {
      final own = await _lanAddresses();
      if (own.isEmpty) {
        _fail('الموبايل غير متصل بالواي فاي.\nاتصل بشبكة الواي فاي نفسها المتصلة بها الشاشة ثم أعد المحاولة.');
        return;
      }
      setState(() => _message = 'الشاشة لم ترد على العنوان المحفوظ ($_screenIp)، جاري البحث عنها على الشبكة...');
      final found = await _findScreen(own);
      if (found == null) {
        _fail('لم يتم العثور على الشاشة على الشبكة.\n'
            'تأكد أن الشاشة مشغّلة ومتصلة بنفس الراوتر المتصل به الموبايل (${own.first}).');
        return;
      }
      if (found != _screenIp) {
        await _saveIp(found);
      }
      try {
        result = await _postValue(found, value);
      } catch (e) {
        _fail('تم العثور على الشاشة ($found) لكن فشل الإرسال: $e');
        return;
      }
    }

    if (result.statusCode == 200) {
      _remoteCap = value;
      await _saveLastCap(value);
      setState(() {
        _status = SendStatus.success;
        _message = 'تم الإرسال بنجاح، واستلمت الشاشة القيمة: $value';
      });
    } else {
      _fail('وصلت الشاشة لكنها رفضت القيمة.\n${result.body}');
    }
  }

  Color get _statusColor {
    switch (_status) {
      case SendStatus.success:
        return Colors.green;
      case SendStatus.failure:
        return Colors.red;
      case SendStatus.sending:
        return Colors.orange;
      case SendStatus.idle:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.rtl,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('صوت الشاشة'),
          actions: [
            IconButton(
              icon: const Icon(Icons.settings),
              tooltip: 'عنوان الشاشة',
              onPressed: _editIpDialog,
            ),
          ],
        ),
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'ادخل اعلى مستوى مسموح للشاشة ان تشغل الصوت عليها',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  decoration: BoxDecoration(
                    color: _remoteCap != null
                        ? Colors.indigo.withOpacity(0.08)
                        : Colors.grey.withOpacity(0.08),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.tv,
                        size: 20,
                        color: _remoteCap != null ? Colors.indigo : Colors.grey,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        _remoteCap != null
                            ? 'آخر قيمة مرسلة: $_remoteCap'
                            : 'لم يتم إرسال أي قيمة بعد',
                        style: TextStyle(
                          fontSize: 15,
                          color: _remoteCap != null ? Colors.indigo : Colors.grey,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                Center(
                  child: Text(
                    _value.round().toString(),
                    style: const TextStyle(fontSize: 64, fontWeight: FontWeight.bold),
                  ),
                ),
                Slider(
                  value: _value,
                  min: 0,
                  max: 100,
                  divisions: 100,
                  label: _value.round().toString(),
                  onChanged: (v) => setState(() => _value = v),
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: _status == SendStatus.sending ? null : _send,
                  icon: _status == SendStatus.sending
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                        )
                      : const Icon(Icons.send),
                  label: const Text('إرسال'),
                  style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16)),
                ),
                const SizedBox(height: 20),
                if (_message.isNotEmpty)
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: _statusColor.withOpacity(0.1),
                      border: Border.all(color: _statusColor),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(
                          _status == SendStatus.success
                              ? Icons.check_circle
                              : _status == SendStatus.failure
                                  ? Icons.error
                                  : Icons.hourglass_top,
                          color: _statusColor,
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(_message, style: TextStyle(color: _statusColor.withOpacity(0.9))),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

