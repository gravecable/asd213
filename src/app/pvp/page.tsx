import { redirect } from "next/navigation";

// игра теперь на корне домена
export default function PvpRedirect() {
  redirect("/");
}
