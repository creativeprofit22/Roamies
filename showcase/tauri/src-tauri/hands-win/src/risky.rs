// Clicks that delete, pay, send or sign out (in English and other common languages) run only when the sidecar
// has asked the user ("confirmed"). The same pattern as RISKY in hands/main.swift and RISKY_CLICK in
// sidecar/safety.mjs, without a regex crate: its optional groups are spelled out below. A phrase counts when
// no letter touches it on either side; the CJK words count anywhere. tests/fixtures/risky.json pins all three.

const PHRASES: &[&str] = &[
    "delete", "remove", "erase", "destroy", "wipe", "reset", "deactivate",
    "close account", "close my account", "close your account",
    "cancel subscription", "cancel plan", "cancel membership", "cancel account", "cancel order",
    "cancel my subscription", "cancel my plan", "cancel my membership", "cancel my account", "cancel my order",
    "cancel your subscription", "cancel your plan", "cancel your membership", "cancel your account", "cancel your order",
    "cancel the subscription", "cancel the plan", "cancel the membership", "cancel the account", "cancel the order",
    "unsubscribe", "pay", "purchase", "buy", "place order", "place the order", "place your order", "checkout", "check out",
    "confirm payment", "confirm order", "confirm purchase", "confirm transfer",
    "send", "transfer", "withdraw", "uninstall", "empty trash", "discard", "sign out", "log out", "logout", "format", "revoke", "publish",
    "eliminar", "borrar", "pagar", "comprar", "enviar", "cerrar sesion", "cerrar sesión",
    "supprimer", "effacer", "payer", "acheter", "envoyer", "se deconnecter", "se déconnecter", "deconnexion", "déconnexion",
    "loschen", "löschen", "entfernen", "bezahlen", "kaufen", "senden", "abmelden",
    "excluir", "apagar", "terminar sessao", "terminar sessão",
    "elimina", "cancella", "paga", "acquista", "invia", "esci",
    "verwijderen", "betalen", "kopen", "verzenden", "uitloggen", "afmelden",
    "padam", "hapus", "bayar", "beli", "hantar", "kirim", "log keluar", "nyahlanggan",
];

const ANYWHERE: &[&str] = &[
    "删除", "刪除", "移除", "清空", "支付", "付款", "购买", "購買", "发送", "發送", "退出登录", "登出", "注销", "削除", "消去", "支払", "購入",
    "送信", "ログアウト", "退会", "삭제", "결제", "구매", "전송", "보내기", "로그아웃",
];

fn whole(s: &str, p: &str) -> bool {
    s.match_indices(p).any(|(i, m)| {
        let before = s[..i].chars().next_back();
        let after = s[i + m.len()..].chars().next();
        before.is_none_or(|c| !c.is_alphabetic()) && after.is_none_or(|c| !c.is_alphabetic())
    })
}

pub fn risky(label: &str) -> bool {
    let s = label.to_lowercase();
    PHRASES.iter().any(|p| whole(&s, p)) || ANYWHERE.iter().any(|p| s.contains(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn labels_match_the_shared_fixture() {
        let f: Value = serde_json::from_str(include_str!("../tests/fixtures/risky.json")).unwrap();
        for l in f["risky"].as_array().unwrap() {
            assert!(risky(l.as_str().unwrap()), "{l} needs a yes");
        }
        for l in f["safe"].as_array().unwrap() {
            assert!(!risky(l.as_str().unwrap()), "{l} is a normal click");
        }
    }
}
