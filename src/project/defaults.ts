/** 工程级默认内容：新建工程时的示例源码。 */

export const DEFAULT_SKETCH = `// ESP32 GPIO 演示：外部 LED 接 D4（GPIO4），BOOT 按键接 GPIO0
#define LED_PIN 4
#define BOOT_PIN 0

int ledState = LOW;
unsigned long lastToggle = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BOOT_PIN, INPUT_PULLUP);
  Serial.println("ESP32 仿真启动 OK");
}

void loop() {
  // 每 500ms 翻转 LED，并在串口打印状态（供串口监视器观察）
  if (millis() - lastToggle >= 500) {
    ledState = !ledState;
    digitalWrite(LED_PIN, ledState);
    lastToggle = millis();
    Serial.println(ledState ? "LED 亮" : "LED 灭");
  }

  // 按键按下（低电平有效）时点亮 LED
  if (digitalRead(BOOT_PIN) == LOW) {
    digitalWrite(LED_PIN, HIGH);
  }
  delay(10);
}
`;

/** 新建工程时的默认电路图（Wokwi 格式）：LED 阳极接 D4（GPIO4），阴极接 GND。 */
export const DEFAULT_DIAGRAM = `{
  "version": 1,
  "parts": [
    { "type": "board-esp32-devkitc", "id": "esp", "top": 40, "left": 40, "attrs": {} },
    { "type": "wokwi-led", "id": "led1", "top": 260, "left": 520, "attrs": { "color": "red" } }
  ],
  "connections": [
    ["led1:A", "esp:D4", "green", []],
    ["led1:C", "esp:GND.1", "green", []]
  ]
}`;
