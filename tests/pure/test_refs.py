from logic.refs import entity_references, rename_entity

from builders import act, all_of, any_of, block, cond, config, svc, tab


def sample():  # type: ignore[no-untyped-def]
    return config(
        tabs=(
            tab(
                "t1",
                conditions=all_of(cond("person.ray", "is", "home")),
                defaults=(act("climate.old", temperature=62),),
            ),
        ),
        blocks=(
            block(
                "b",
                conditions=any_of(all_of(cond("climate.old", "gt", "60", "temperature"))),
                actions=(act("climate.old", temperature=70), svc("script.turn_on", "climate.old")),
            ),
        ),
    )


def test_entity_references() -> None:
    assert entity_references(sample()) == {"person.ray", "climate.old"}


def test_rename_entity_everywhere() -> None:
    renamed = rename_entity(sample(), "climate.old", "climate.new")
    assert entity_references(renamed) == {"person.ray", "climate.new"}
    assert renamed.blocks[0].actions[1].target == {"entity_id": ["climate.new"]}  # type: ignore[union-attr]


def test_rename_unknown_entity_is_noop() -> None:
    cfg = sample()
    assert rename_entity(cfg, "light.nope", "light.other") is cfg
