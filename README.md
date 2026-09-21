# Sowel Recipe — Accès partagés : ouverture

Ouvre le portail, la porte ou le garage quand une personne à qui vous avez donné un accès le
demande depuis son téléphone — un invité, un enfant, un artisan. Les demandes arrivent par le
plugin [Accès partagés](https://github.com/adn-dev-adrien/sowel-plugin-guest-access), qui tient
les accès, les codes et la page d'ouverture ; cette recette est ce qui décide et actionne.

**Une seule instance pour toute la maison** (v0.4). Elle tend au plugin la liste des portails de la
maison — les équipements de type `gate`, avec leur nom et leur contact — et c'est dans la page
Accès partagés que le propriétaire choisit, avec « + portail », ceux qui auront une liste d'accès.
Chaque demande désigne ensuite son portail, et la recette actionne celui-là.

## Pourquoi une recette, et pas le plugin lui-même

Parce que **rien de ce qui décide ne doit aussi actionner**. Le plugin sert une page anonyme sur
Internet et détient les accès ; tout ce qu'il fait ici, c'est publier un compteur et le portail visé.
La recette **n'actionne jamais qu'un équipement de type portail** : quoi que le plugin désigne, rien
d'autre dans la maison ne peut être commandé par ce chemin.

Et elle vous laisse un interrupteur : la tuile du Dashboard arme ou coupe l'accès invités en un clic,
sans ouvrir la page des accès et sans attendre quoi que ce soit. Un accès coupé n'échoue pas en
silence — le téléphone du visiteur affiche que la commande a été refusée depuis la maison.

## Ce qu'elle ne fait pas, volontairement

- **Elle ne regarde pas si le portail est ouvert avant de pulser.** Cette garde existait dans la
  première version, pour éviter qu'un deuxième client referme le portail sur la voiture du premier.
  Elle retirait quelque chose de légitime : refermer derrière soi. Décision d'Adrien du 2026-09-10 —
  la commande part toujours, comme la télécommande qu'elle remplace, avec la même propriété qu'un
  appui pendant la course inverse le mouvement.
- **Elle ne déduplique pas.** Le plugin absorbe déjà le double appui (fenêtre de 2 s), et c'est le
  seul endroit qui peut distinguer un doigt qui ripe de deux intentions.
- **Elle ne tient aucune échéance.** Rien ici ne referme le portail :
  [`portal-night-closure`](https://github.com/adn-dev-adrien/sowel-recipe-portal-night-closure) s'en
  charge, et deux automatisations tenant chacune sa propre échéance sur un portail à impulsion
  envoient deux impulsions pour une ouverture.

## La liste des portails repart dans l'autre sens

Un plugin ne peut pas lire les équipements d'une autre intégration : c'est donc la recette qui lui
pousse, par l'ordre `gate_catalog`, la liste des portails avec leur nom et leur contact — au
démarrage, puis à chaque création, renommage, suppression ou mouvement d'un portail, jamais deux
fois la même. **Le visiteur, lui, ne le voit jamais** — un bouton
qui dit « Fermer le portail » est un afficheur d'état déguisé en verbe, et la page d'ouverture est
interrogeable par qui détient un code. C'est le propriétaire qui le voit, sur la page « Accès
invités » de Sowel.

L'état est lu **par catégorie** (`gate_state`, sinon `contact_door`), ce qui évite un champ d'alias
à remplir et survit à une installation nommée autrement.

## Réglages

| Champ | Défaut | Note |
| --- | --- | --- |
| Zone | — | Où ranger la tuile |
| Demandes d'ouverture | — | L'équipement lié au device « Accès invités » du plugin `guest-access` |
| Alias du compteur | `requests` | La donnée qui compte les demandes |
| Alias de la commande | `command` | L'ordre envoyé au portail visé |
| Valeur de la commande | `pulse` | Une impulsion |

Plus de champ « Portail » : les portails se choisissent dans le plugin. La commande est la même pour
tous les portails de la maison.

La validation refuse une configuration muette : sans les ordres `result` et `gate_catalog`, ni les
données `requests` et `last_request_gate` sur l'équipement des demandes, la recette ne pourrait ni
répondre au visiteur ni proposer de portail — elle le signale à la création plutôt qu'à l'usage.
Un équipement créé avant la v1.4 du plugin n'a pas ces liaisons : recréez-le depuis le device.

## Deux garde-fous

- **Le compteur ne déclenche jamais sur sa première lecture.** Au démarrage la donnée a déjà une
  valeur ; un redémarrage de recette ne doit pas ouvrir le portail.
- **Seule une valeur strictement supérieure** est une nouvelle demande. Une relecture identique,
  une valeur plus basse, une valeur non numérique : rien ne part.

## Installation

Source personnelle (spec 136) : **Plugins → Store → Sources personnelles** →
`adn-dev-adrien/sowel-recipe-guest-gate` → Installer → confirmer l'empreinte.

Une seule instance, liée à l'équipement du plugin `guest-access` (device « Accès invités »). Les
portails se choisissent ensuite dans Accès partagés → « + portail ».

## Licence

AGPL-3.0
