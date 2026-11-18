import type { InputHTMLAttributes } from "react";
import { INPUT, INPUT_STYLE } from "../../workspace/Chrome.tsx";

/** A text field for a row's control column or a form's rows: the house input height and edge unless the caller says otherwise. */
export function FormInput({ className, style, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const box = rest.type === "checkbox" || rest.type === "radio";
  return <input {...rest} className={className ?? (box ? undefined : INPUT)} style={box ? style : { ...INPUT_STYLE, ...style }} />;
}
