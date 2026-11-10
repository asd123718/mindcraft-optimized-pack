export class NPCData {
    constructor() {
        this.goals = [];
        this.curr_goal = null;
        this.built = {};
        this.home = null;
        this.do_routine = false;
        this.do_set_goal = false;
    }

    toObject() {
        let obj = {};
        if (this.goals.length > 0)
            obj.goals = this.goals;
        if (this.curr_goal)
            obj.curr_goal = this.curr_goal;
        if (Object.keys(this.built).length > 0)
            obj.built = this.built;
        if (this.home)
            obj.home = this.home;
        obj.do_routine = this.do_routine;
        obj.do_set_goal = this.do_set_goal;
        return obj;
    }

    static fromObject(obj) {
        let npc = new NPCData();
        if (!obj) return npc;
        // Profile snapshots must not restart goals or routines on world join.
        if (obj.built)
            npc.built = obj.built;
        if (obj.home)
            npc.home = obj.home;
        return npc;
    }
}
