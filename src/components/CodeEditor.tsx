import Editor from "@monaco-editor/react";

interface Props {
  code: string;
  onChange: (v: string) => void;
}

export default function CodeEditor({ code, onChange }: Props) {
  return (
    <Editor
      height="100%"
      defaultLanguage="cpp"
      theme="vs-dark"
      value={code}
      onChange={(v) => onChange(v ?? "")}
      beforeMount={(monaco) => {
        monaco.languages.register({ id: "cpp" });
      }}
      options={{
        fontSize: 14,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        tabSize: 2,
        wordWrap: "on",
        lineNumbers: "on",
      }}
    />
  );
}
